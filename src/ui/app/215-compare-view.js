/* ───────────────────────────── Compare view ───────────────────────────── */
async function loadCompareOptions() {
  // The pair a comparison on screen answers is kept through a reload, so new
  // scans do not move the lists off it while the result stays below (C08).
  const shown = state.compare.result;
  try {
    const [scansRes, snapsRes] = await Promise.all([api('/api/scans'), api('/api/snapshots?all=true')]);
    const options = [];
    for (const s of scansRes.scans) {
      options.push({ kind: 'scan', id: s.scanId, rootPath: s.rootPath, when: s.finishedAt, size: s.totalSize });
    }
    for (const sn of snapsRes.snapshots) {
      options.push({ kind: 'snap', id: sn.id, rootPath: sn.rootPath, when: sn.takenAt, size: sn.totalSize });
    }
    state.compare.options = options;
    if (!options.length) {
      $('cmpA').innerHTML = $('cmpB').innerHTML = '<option>No scans yet</option>';
      $('cmpA').disabled = $('cmpB').disabled = true;
      cmpSyncResult();
      return;
    }
    $('cmpA').disabled = $('cmpB').disabled = false;

    const byRoot = new Map();
    for (const o of options) {
      if (!byRoot.has(o.rootPath)) byRoot.set(o.rootPath, []);
      byRoot.get(o.rootPath).push(o);
    }
    const labels = cmpOptionLabels(options);
    const html = [...byRoot.entries()].map(([root, list]) =>
      `<optgroup label="${escapeHtml(root)}">` +
      list.sort((x, y) => y.when - x.when).map(o =>
        `<option value="${o.kind}:${o.id}">${escapeHtml(labels.get(o))}</option>`).join('') +
      '</optgroup>').join('');
    $('cmpA').innerHTML = html;
    $('cmpB').innerHTML = html;

    // Defaults: newest two entries OF THE SAME KIND for the current (or
    // first) root, older → newer. "Newest two overall" always paired the
    // newest scan with the snapshot that scan itself saved — same timestamp,
    // mixed kinds, and the exact pair the Run button refuses (QA D2).
    const rootKey = state.root && byRoot.has(state.root.path) ? state.root.path : [...byRoot.keys()][0];
    const list = byRoot.get(rootKey).sort((x, y) => y.when - x.when);
    const scans = list.filter((o) => o.kind === 'scan');
    const snaps = list.filter((o) => o.kind === 'snap');
    const pool = scans.length >= 2 ? scans : snaps.length >= 2 ? snaps : list;
    if (shown && parseCmp(shown.a) && parseCmp(shown.b)) {
      $('cmpA').value = shown.a;
      $('cmpB').value = shown.b;
      $('cmpInfo').textContent = '';
    } else {
      $('cmpB').value = `${pool[0].kind}:${pool[0].id}`;
      if (pool.length > 1) $('cmpA').value = `${pool[1].kind}:${pool[1].id}`;
      $('cmpInfo').textContent = pool.length < 2 ? 'Only one record of this folder so far — scan it again to have something to compare.' : '';
    }
    cmpSyncResult();
  } catch (e) {
    toast('Could not load scans: ' + e.message, 'error');
  }
}

/**
 * Every pick's text in Before and After, each one its own (QA third pass).
 * Led by the folder's name (C08): a closed list shows one option, and
 * corpus, Mail, Projects and a single file were told apart only by size.
 * Two scans of a folder made in the same minute still both read "Scan (full
 * diff) · Oct 13, 3:30 PM · 9.5 GB", so a label that another shares names
 * its moment to the second, and one that shares even that gets its place in
 * time, "(2 of 2)". A label that is already its own keeps its minute.
 */
function cmpOptionLabels(options) {
  const text = (o, when) => `${lastPathSegment(o.rootPath)} · ${o.kind === 'scan' ? 'Scan (full diff)' : 'History'} · ${when} · ${formatBytes(o.size)}`;
  const labels = new Map(options.map((o) => [o, text(o, formatWhen(o.when))]));
  const shared = () => {
    const by = new Map();
    for (const [o, label] of labels) by.set(label, [...(by.get(label) || []), o]);
    return [...by.values()].filter((group) => group.length > 1);
  };
  for (const group of shared()) for (const o of group) labels.set(o, text(o, formatWhenSeconds(o.when)));
  for (const group of shared()) {
    const inTime = [...group].sort((a, b) => a.when - b.when);
    inTime.forEach((o, i) => labels.set(o, `${labels.get(o)} (${i + 1} of ${inTime.length})`));
  }
  return labels;
}

/** The two moments a comparison is between, as its heading names them: to the second when they share a minute (QA third pass). */
function cmpWhenPair(a, b) {
  const pair = [formatWhen(a), formatWhen(b)];
  return pair[0] === pair[1] ? [formatWhenSeconds(a), formatWhenSeconds(b)] : pair;
}

/**
 * The comparison on screen is about the two picks the lists show, or it goes
 * (C08). `state.compare.result` is the pair it answers, as the two lists'
 * values; a reload that lost one of them, or a person picking another scan,
 * takes the comparison down rather than leaving it under a pair it is not
 * about. Picking the old pair again brings nothing back: Compare does.
 */
function cmpSyncResult() {
  const shown = state.compare.result;
  const a = $('cmpA').value, b = $('cmpB').value;
  if (shown && shown.a === a && shown.b === b) return;
  if (shown) {
    state.compare.result = null;
    cmpCountsDrop();
    fxHuntBeamSync('cmpBody', false);
  } else if (!state.compare.notice) {
    return; // nothing compared yet: the first prompt already says to pick two scans of one folder
  }
  // From here the card speaks for the picks shown, every time they change: the
  // reason Compare would refuse them, or the invitation to press it — never
  // "press Compare" beside the refusal Compare then toasts (E07).
  state.compare.notice = true;
  const refusal = cmpPairRefusal(parseCmp(a), parseCmp(b));
  $('cmpBody').innerHTML = `<div class="card glass"><div class="muted">${refusal
    ? `${escapeHtml(refusal)} — these two cannot be compared.`
    : 'The picks changed since the last comparison — press Compare to compare these two.'}</div></div>`;
}

/** Why Compare refuses two picks, in the words its toast and the card both say (E07); null when it compares them. */
function cmpPairRefusal(a, b) {
  if (!a || !b) return 'Pick two scans to compare';
  if (a.rootPath !== b.rootPath) return 'Both picks must cover the same folder';
  if (a.kind === b.kind && a.id === b.id) return 'Pick two different scans';
  if (a.kind !== b.kind) return 'Mixing a live scan with a history snapshot isn’t supported — pick two of the same kind';
  return null;
}
$('cmpA').addEventListener('change', cmpSyncResult);
$('cmpB').addEventListener('change', cmpSyncResult);

/** The "Don't scan" rules a Compare pick ran with: a live scan's under its scan id, a snapshot's under its own (B24). */
function cmpCoverage(o) {
  return coverageFor(o.rootPath, o.kind === 'scan' ? 'scan:' + o.id : o.id);
}

function parseCmp(value) {
  const i = value.indexOf(':');
  if (i < 0) return null;
  const kind = value.slice(0, i), id = value.slice(i + 1);
  return state.compare.options.find(o => o.kind === kind && o.id === id) || null;
}

$('cmpRunBtn').addEventListener('click', async () => {
  const a = parseCmp($('cmpA').value), b = parseCmp($('cmpB').value);
  const refusal = cmpPairRefusal(a, b);
  if (refusal) { toast(refusal, 'error'); return; }
  const body = $('cmpBody');
  // The pair this comparison answers: a pick changed before it lands drops it (C08).
  const pair = { a: $('cmpA').value, b: $('cmpB').value };
  state.compare.result = pair;
  cmpCountsDrop(); // the rewrite below would strand a live counts handle
  body.innerHTML = `<div class="card glass dup-progress">${icon('loader', 20, REDUCED ? '' : 'spin')}<span>Comparing…</span></div>`;
  // FX: the md ring marks the diff computing — on with the progress card,
  // dropped (the card is innerHTML-transient) before every rewrite that
  // settles it: render, error, and the history view's unmount.
  fxHuntBeamSync('cmpBody', true);
  const rules = coverageRules(cmpCoverage(a), cmpCoverage(b));
  try {
    if (a.kind === 'scan') {
      const diff = await api(`/api/compare?scanIdA=${a.id}&scanIdB=${b.id}`);
      if (state.compare.result !== pair) return; // the picks changed meanwhile: cmpSyncResult has spoken
      fxHuntBeamSync('cmpBody', false);
      renderCompare({ entries: diff.entries, totalDelta: diff.totalDelta, truncated: diff.truncated, deep: true, whenA: a.when, whenB: b.when, rules });
    } else {
      const diff = await api(`/api/snapshots/compare?a=${a.id}&b=${b.id}`);
      if (state.compare.result !== pair) return;
      fxHuntBeamSync('cmpBody', false);
      // §7.4 — a same-root snapshot pair also gets the split-slider maps.
      renderCompare({ entries: diff.entries, totalDelta: diff.totalDelta, truncated: false, deep: false, whenA: diff.a.takenAt, whenB: diff.b.takenAt, splitRoot: a.rootPath, rules });
    }
  } catch (e) {
    if (state.compare.result !== pair) return;
    fxHuntBeamSync('cmpBody', false);
    body.innerHTML = `<div class="card glass"><div class="muted">Compare failed: ${escapeHtml(e.message)}</div></div>`;
  }
});

/* ── §7.4 — the split-slider: two snapshot treemaps behind one divider ──
   Both layouts come from /api/snapshots/tree (percent-space rects, the same
   shape the live renderer draws), painted into ONE canvas: the newer map in
   full, then the older clipped to the divider's left — a photo-comparison
   wipe. The divider is a NATIVE range input so arrows, Home and End are the
   platform's own; aria-valuetext narrates the position, the reclaim-weight
   sliders' pattern. Everything lives on elements this render created, so
   there is nothing for unmount to take back; the one static listener
   (resize) checks the canvas is still on screen before it draws. */
let cmpSplit = null; // { a, b, whenA, whenB, said } — percent-node layouts, and the two moments as they are named
let cmpSplitSeq = 0;

async function initCmpSplit(rootPath, whenA, whenB) {
  const seq = ++cmpSplitSeq;
  const note = $('cmpSplitNote');
  // Left of the divider is promised to be the OLDER — keep that promise even
  // when the user picked the pair newest-first (review RD7).
  const [tA, tB] = whenA <= whenB ? [whenA, whenB] : [whenB, whenA];
  try {
    const [la, lb] = await Promise.all([
      api(`/api/snapshots/tree?path=${encodeURIComponent(rootPath)}&at=${tA}`),
      api(`/api/snapshots/tree?path=${encodeURIComponent(rootPath)}&at=${tB}`),
    ]);
    if (seq !== cmpSplitSeq) return; // a slower earlier compare must not paint over a newer one (review RD6)
    // closestSnapshot answers with the nearest stored tree; if both picks
    // resolve to the same one there is nothing to wipe between — say so.
    if (la.snapshot.takenAt === lb.snapshot.takenAt) {
      const card = $('cmpSplitCard');
      if (card) card.hidden = true;
      return;
    }
    // Named as the heading names them: to the second when they share a
    // minute, so the two sides never read alike (review F1.3 of QA third pass).
    const whenA = la.snapshot.takenAt, whenB = lb.snapshot.takenAt;
    cmpSplit = { a: la.nodes, b: lb.nodes, whenA, whenB, said: cmpWhenPair(whenA, whenB) };
    // The footer speaks for what the canvas actually shows — the nearest
    // STORED trees, which can differ from the picked times (review H11).
    const foot = $('cmpSplitFoot');
    if (foot) foot.innerHTML =
      `<span>◀ ${cmpSplit.said[0]}</span><span>${cmpSplit.said[1]} ▶</span>`;
    const range = $('cmpSplitRange');
    range.addEventListener('input', () => cmpSplitDraw());
    cmpSplitDraw();
  } catch (e) {
    if (seq !== cmpSplitSeq) return;
    cmpSplit = null;
    if (note) note.textContent = `No split view: ${e.message}`;
  }
}

function cmpSplitDraw() {
  const canvas = $('cmpSplitCanvas');
  if (!canvas || !cmpSplit) return;
  const range = $('cmpSplitRange');
  const pct = Number(range.value);
  range.setAttribute('aria-valuetext',
    `${pct} percent — left of the divider: ${cmpSplit.said[0]}, right: ${cmpSplit.said[1]}`);
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cw * dpr)) canvas.width = Math.round(cw * dpr);
  if (canvas.height !== Math.round(ch * dpr)) canvas.height = Math.round(ch * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // own the matrix — never scale on top of an inherited one
  const paint = (nodes) => {
    ctx.fillStyle = cssVar('--bg-1') || '#0e0e13';
    ctx.fillRect(0, 0, cw, ch);
    for (const n of nodes) {
      // Only EXPANDED dirs are frames around their children; an unexpanded
      // dir (depth cap, pruned children) is a leaf cell carrying the deep
      // bytes — skipping every dir left most of a real tree as background
      // holes (review RD1).
      if (n.expanded) continue;
      const x = (n.x / 100) * cw, y = (n.y / 100) * ch;
      const w = (n.w / 100) * cw, h = (n.h / 100) * ch;
      if (w < 0.5 || h < 0.5) continue;
      ctx.fillStyle = sizeColor(n.size, 0.92);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    }
  };
  const splitX = (pct / 100) * cw;
  paint(cmpSplit.b); // the newer scan, in full
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, splitX, ch);
  ctx.clip();
  paint(cmpSplit.a); // the older scan, revealed left of the divider
  ctx.restore();
  ctx.fillStyle = cssVar('--accent') || '#0A84FF';
  ctx.fillRect(splitX - 1, 0, 2, ch);
}

window.addEventListener('resize', () => {
  if (state.view === 'history' && $('cmpSplitCanvas')) cmpSplitDraw();
});

/* Compare's counts chart is a live DOM handle inside a card this function
   rewrites wholesale — so it dies BEFORE the rewrite that would strand it
   (the budget-gauge rule), and again with the view. */
let cmpCountsHandle = null;
function cmpCountsDrop() {
  if (cmpCountsHandle) { cmpCountsHandle.destroy(); cmpCountsHandle = null; }
}

function renderCompare(r) {
  cmpSplit = null; // a fresh card owns the canvas; a stale draw must find nothing
  cmpCountsDrop();
  const counts = { added: 0, removed: 0, grew: 0, shrank: 0 };
  // Left out, or let back in, by a changed "Don't scan" rule: neither added
  // nor removed (B24).
  let ruled = 0;
  for (const en of r.entries) {
    if (coverageExplains(en, r.rules || null)) { ruled++; continue; }
    counts[en.sizeA === null ? 'added' : en.sizeB === null ? 'removed' : en.delta > 0 ? 'grew' : 'shrank']++;
  }
  const up = r.totalDelta > 0;
  // No change is said as none, as Trends says it — not "Total grew by 0 B"
  // in the growth colour (C07 review F1.2).
  const total = r.totalDelta === 0 ? 'Total did not change'
    : `Total ${up ? 'grew' : 'shrank'} by
        <b class="cmp-total" style="color:${up ? '#ff6b61' : 'var(--ok)'}">${formatBytes(Math.abs(r.totalDelta))}</b>`;
  const maxD = Math.abs(r.entries[0]?.delta ?? 0) || 1;
  const splitCard = r.splitRoot ? `
    <div class="card glass" id="cmpSplitCard">
      <h2><span style="display:inline-flex;">${icon('diff', 13)}</span>Split view</h2>
      <div class="muted" style="margin-bottom:8px;">Drag the divider — or focus it and use the arrow keys; Home and End snap. Left of the line is the older scan, right is the newer.</div>
      <div class="cmp-split">
        <canvas id="cmpSplitCanvas" aria-hidden="true"></canvas>
        <input type="range" id="cmpSplitRange" min="0" max="100" step="1" value="50"
               aria-label="Reveal divider between the two scans — left of it shows the older scan, right the newer" aria-valuetext="50 percent">
      </div>
      <div class="rule-row num muted" id="cmpSplitFoot" style="justify-content:space-between;">
        <span>Loading the two maps…</span>
      </div>
      <div class="muted" id="cmpSplitNote" role="status"></div>
    </div>` : '';
  $('cmpBody').innerHTML = splitCard + `
    <div class="card glass">
      <h2><span style="display:inline-flex;">${icon('diff', 13)}</span>${cmpWhenPair(r.whenA, r.whenB).join(' → ')}${r.deep ? '' : ' · top-level folders only'}</h2>
      <div class="muted num" style="margin-bottom:12px;">${total}
        &nbsp;·&nbsp; <span class="cmp-ct" data-n="${counts.added}">${counts.added}</span> added · <span class="cmp-ct" data-n="${counts.removed}">${counts.removed}</span> removed · <span class="cmp-ct" data-n="${counts.grew}">${counts.grew}</span> grew · <span class="cmp-ct" data-n="${counts.shrank}">${counts.shrank}</span> shrank${
        ruled ? ` · ${ruled} changed by your “Don’t scan” rules` : ''}${r.truncated ? ' · biggest 1,000 shown' : ''}</div>
      ${r.rules ? `<div class="muted" style="margin:-6px 0 12px;">${icon('alert', 13)} Your “Don’t scan” rules changed between these two scans, so part of this difference is what was scanned, not what is on disk.</div>` : ''}
      ${r.entries.length ? '<div id="cmpCounts"></div>' : ''}
      ${r.entries.length
        ? r.entries.slice(0, 200).map(en => deltaRow(en, maxD, { offerSnapshots: true, rules: r.rules || null })).join('')
        : `<div class="muted" style="display:flex;align-items:center;gap:8px;">${icon('checkCircle', 15)} No differences — nothing changed between these two.</div>`}
    </div>`;
  // Animated counts: the from-zero roll the quick stats use, on the totals
  // just computed — and the same four counts again as discrete square
  // stacks, because a count is a number of whole things.
  if (r.totalDelta !== 0) countUp($('cmpBody').querySelector('.cmp-total'), Math.abs(r.totalDelta), formatBytes);
  $('cmpBody').querySelectorAll('.cmp-ct').forEach(el => countUp(el, Number(el.dataset.n)));
  if (r.entries.length) {
    cmpCountsHandle = FxCharts.barSquares($('cmpCounts'), {
      items: [
        { name: 'Added', value: counts.added },
        { name: 'Removed', value: counts.removed },
        { name: 'Grew', value: counts.grew },
        { name: 'Shrank', value: counts.shrank },
      ],
      squareSize: 10, height: 60, gradient: true, labelWidth: 56,
      formatValue: formatCount, valueName: 'Entries',
    });
  }
  fxBarsIn($('cmpBody')); // the diverging delta bars ride the kit's width-in
  if (r.splitRoot) initCmpSplit(r.splitRoot, r.whenA, r.whenB);
  wireSnapshotActions($('cmpBody'));
}

/* ───────────────────────────── Browse modal ───────────────────────────── */
let browsePath = null;
let browseOnPick = null; // when set, "Use this folder" hands the path to this instead of scanning
// Each listing asked for takes the next number, and only the newest one's
// answer is shown: a sleeping NAS answers late (review F1.8). Closing the
// picker retires every listing still on its way — see browseClosed.
let browseSeq = 0;
/** A path as the server reads one (sanitizePath): leading whitespace is paste
    debris and goes, a trailing space is part of a folder's name and stays.
    Trimming it turned "Screenshots " (a name macOS and Linux allow, spelled so
    by the picker, a saved policy or the last scan) into its sibling
    "Screenshots", or into nothing. Every path box is read this way (review
    F1.1, F2.1, F2.4, F2.8). */
function asPath(text) {
  return String(text ?? '').replace(/^\s+/, '');
}
/** The folder a path that names none probably meant: the same path without
    the whitespace at its end, when the path was refused as not found and a
    folder has the shorter name. A double-click selection often carries a stray
    space, invisible in the field and in "Path does not exist". Null when there
    is no such folder or it cannot be looked up. It is only ever OFFERED
    (offerMeant), never used in the path's place: "Screenshots " that has gone
    is not "Screenshots", and a scan, a pick or a policy acts on exactly the
    path typed or stored (QA4a R4-1). */
async function meantFolder(p, err) {
  const bare = p.replace(/\s+$/, '');
  if (!err || err.code !== 'PATH_NOT_FOUND' || !bare || bare === p) return null;
  try {
    return (await api('/api/fs/list?path=' + encodeURIComponent(bare))).path || bare;
  } catch {
    return null;
  }
}
/** What a path ends with, in words. A trailing space is all that tells the
    path typed from the folder offered, and shown it is a hairline gap before
    a closing quote — to a screen reader, nothing: both names read the same,
    and "no such folder" read as a contradiction (final review F1.13). */
function trailingBlanks(p) {
  const tail = (/\s+$/.exec(p) || [''])[0];
  const n = tail.length;
  if (/^ +$/.test(tail)) return n === 1 ? 'a space' : `${n} spaces`;
  if (/^\t+$/.test(tail)) return n === 1 ? 'a tab' : `${n} tabs`;
  return n === 1 ? 'a blank character' : `${n} blank characters`;
}
/** "No such folder" for the path as typed, what it ends with said in words,
    and the folder it probably meant as the one choice. The paths ride in the
    message, which wraps; the button is a short verb for what choosing does
    there (`label`) — a path in it could not shrink, and hung off the toast
    and past the window's edge (final review F1.9). It answers the person's
    own press, so its button takes focus: from inside a sheet the keyboard
    could not reach it otherwise (final review F1.10). `sheet` is the id of
    the sheet the press was made in: the offer goes when that sheet closes
    (final review F2.2, F2.3). */
function offerMeant(p, meant, choose, label = 'Use that folder', sheet = null) {
  toastAction(`${noFolderNamed(p)} Did you mean “${meant}”?`, label, choose, 'error', 12000, { focus: true, sheet });
}
/** "No folder is named “…” — the path ends with a space." */
function noFolderNamed(p) {
  return `No folder is named “${p}” — the path ends with ${trailingBlanks(p)}.`;
}
/** How long Scan or Save waits on a path box's lookup (boxMeant) before
    going ahead with the path exactly as it is: a sleeping network drive can
    take minutes to answer, and the scan or the policy then answers for the
    path as it does for any other (QA4a R4-3). */
const PATH_LOOKUP_MS = 3000;
/** Whether boxMeant looks `p` up before it is scanned or saved: only a path
    ending in whitespace is. */
function boxLooksUp(p) {
  return /\s$/.test(p);
}
/** Before a path box's folder is scanned or saved: the folder it probably
    meant (meantFolder) when the path names none, or null to go ahead with the
    path exactly as it is — also once PATH_LOOKUP_MS pass without an answer.
    Only a path ending in whitespace is looked up. It never throws: the URL is
    built inside the promise chain, so a path encodeURIComponent cannot encode
    (a pasted lone surrogate) is a failed lookup — null — and not a throw out
    of a press that holds its button (final review F1.5). */
function boxMeant(p) {
  if (!boxLooksUp(p)) return Promise.resolve(null);
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), PATH_LOOKUP_MS); });
  const lookup = Promise.resolve()
    .then(() => api('/api/fs/list?path=' + encodeURIComponent(p)))
    .then(() => null, (e) => meantFolder(p, e));
  return Promise.race([lookup, late]).finally(() => clearTimeout(timer));
}
/** Open the folder picker. `onPick` takes the folder chosen in place of a
    scan; `useLabel` names what the one action button then does. The button
    says "Scan this folder" only when it scans: static, it read so for an
    offload — which trashes the originals — and for the Autopilot folder,
    which only fills a box (final review F1.7). */
/** The picker's line under the path, when its caller names none. */
const BROWSE_HINT = 'Type a path and press Enter, or open a folder below.';
/** `where`: what a caller puts in place of the home folder's shortcuts and the
    line under the path — an offload offers connected drives, and says why a
    folder on the files' own drive will not do (E01). */
async function openBrowse(start, onPick = null, title = null, useLabel = null, where = null) {
  browseOnPick = onPick;
  $('browseTitle').innerHTML = icon('folder', 18) + (title || 'Choose a folder');
  $('browseUseBtn').innerHTML = icon('check', 16) + escapeHtml(useLabel || (onPick ? 'Use this folder' : 'Scan this folder'));
  $('browseHint').textContent = where?.hint || BROWSE_HINT;
  $('browseModal').classList.add('open');
  const chips = $('browseChips');
  const shortcuts = where?.chips ?? (state.system?.commonDirs ?? []).map((d) => ({ path: d, name: d.split(/[\\/]/).pop() || d }));
  chips.innerHTML = shortcuts.map(d =>
    `<button class="pill" data-p="${escapeHtml(d.path)}">${icon(where?.chips ? 'disc' : 'folder', 12)}${escapeHtml(d.name)}</button>`).join('');
  chips.querySelectorAll('.pill').forEach(c => c.addEventListener('click', () => browseTo(c.dataset.p)));
  // A start from a path box is a typed path: one that names no folder offers
  // the folder it probably meant (meantFolder).
  await browseTo(start || state.system?.homeDir || '/', !!start);
}
/** Ordinary folders first, dot-folders after them, each in the server's order
    (QA D05: in a home folder .agents, .cache… pushed Documents below the fold). */
function browseOrder(dirs) {
  return [...dirs.filter((d) => !d.isHidden), ...dirs.filter((d) => d.isHidden)];
}
/** List a folder in the picker, exactly as given. True when it opened; a
    failure is a toast and leaves the picker where it was. `typed`: a path from
    a box or the path line, which on "no such folder" offers the folder it
    probably meant (meantFolder) — offered, never opened in its place. A folder
    the server listed is never looked up under another name. */
async function browseTo(path, typed = false) {
  const seq = ++browseSeq;
  // A newer listing (a chip, a row, the picker opened again) overtakes any
  // press of "Scan this folder" still opening a typed path, and that press
  // will act on nothing, so the button it held is handed back here. A sleeping
  // NAS can keep the old listing waiting for minutes (review F2.3, F2.5).
  $('browseUseBtn').disabled = false;
  try {
    const data = await api('/api/fs/list?path=' + encodeURIComponent(path));
    // A newer listing was asked for, or the picker closed, while this one was
    // on its way: its answer is not shown, and it did not open.
    if (seq !== browseSeq) return false;
    browsePath = data.path;
    const field = $('browseCurrent');
    field.value = data.path;
    // An unfocused field shows the START of its value, and the end of a long
    // path is the folder about to be scanned or picked: scroll to it. The
    // tooltip holds the whole path (review F1.9).
    field.title = data.path;
    field.scrollLeft = field.scrollWidth;
    const list = $('browseList');
    const rows = [];
    // The server sends at most 500 subfolders — the first 500 in this order —
    // and how many there are; a cut list says so above the folders (POL item 2).
    if (typeof data.total === 'number' && data.total > data.dirs.length) {
      rows.push(`<div class="muted" role="note" style="padding:8px 12px; font-size:12px;">Showing the first ${formatCount(data.dirs.length)} of ${formatCount(data.total)} folders. Type a path above to open one that is not listed.</div>`);
    }
    if (data.parent) rows.push(`<button class="browse-item" data-p="${escapeHtml(data.parent)}" aria-label="Up one level">${icon('arrowUp', 14)} <b>..</b></button>`);
    rows.push(...browseOrder(data.dirs).map(d =>
      `<button class="browse-item" data-p="${escapeHtml(d.path)}" aria-label="Open ${escapeHtml(d.name)}">${icon('folder', 14)} <span class="${d.isHidden ? 'hid' : ''}">${escapeHtml(d.name)}</span></button>`));
    // The rows are replaced. Focus on one of them — the row just opened, or
    // ".." — would fall to the page with it, and the next Tab start over at
    // the top of the sheet: it goes to the new list's first row (the path
    // field when the list has none). And the list is its own scroller: the new
    // listing opens at its top, where the cut-list note and ".." are, not at
    // the old listing's offset (POL item 2 review, F2.10).
    const focusInList = list.contains(document.activeElement);
    list.innerHTML = rows.join('') || '<div class="muted" style="padding:14px;">No subfolders.</div>';
    list.scrollTop = 0;
    list.querySelectorAll('.browse-item').forEach(b => b.addEventListener('click', () => browseTo(b.dataset.p)));
    if (focusInList) (list.querySelector('.browse-item') || $('browseCurrent')).focus();
    return true;
  } catch (e) {
    // An overtaken listing is not looked up further: nothing would show it.
    const meant = typed && seq === browseSeq ? await meantFolder(path, e) : null;
    if (seq !== browseSeq) return false;
    if (meant) offerMeant(path, meant, () => browseTo(meant), 'Open that folder', 'browseModal');
    else toast(e.message, 'error');
    return false;
  }
}
/** Every way the picker closes (Escape, the ✕, the scrim, a Use that acted)
    runs through closeModal, which calls this: a typed path still opening when
    the sheet goes is never acted on — no pick (an offload destination), no
    scan, no toast about a sheet that is gone. */
function browseClosed() {
  browseSeq++;
  $('browseUseBtn').disabled = false; // the press it held is retired with it
}
/** The path line as a path (asPath): the folder shown, as the server spelled
    it, until someone edits it. */
function browseFieldPath() {
  return asPath($('browseCurrent').value);
}
$('browseBtn').addEventListener('click', () => openBrowse(asPath($('pathInput').value) || null));
$('emptyBrowseBtn').addEventListener('click', () => openBrowse(null));
// The path line is the picker's typing route (QA D05) — before the first scan
// the Scan card's path box is not on screen, so this sheet is the only door.
$('browseCurrent').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const typed = browseFieldPath();
  if (typed) return browseTo(typed, true);
});
$('browseUseBtn').addEventListener('click', async () => {
  const btn = $('browseUseBtn');
  // A path typed but not opened yet is opened first, and acted on only if it
  // opened: the folder shown before it is never scanned in its place. Until
  // someone edits it the field holds the folder shown, spelled as the server
  // listed it, so a folder picked from the list is never looked up again.
  const typed = browseFieldPath();
  if (typed && typed !== browsePath) {
    // Held while it opens, so a second press cannot act twice. Only this
    // press's own listing hands it back: a newer listing or the picker
    // closing already has, and a newer press may be holding it now.
    const opening = browseTo(typed, true);
    const mine = browseSeq;
    btn.disabled = true;
    const opened = await opening;
    if (mine === browseSeq) btn.disabled = false;
    // Not opened, or overtaken while it opened, by a newer listing or by the
    // picker closing: nothing is acted on.
    if (!opened) return;
  }
  const pick = browseOnPick;
  browseOnPick = null;
  closeModal('browseModal');
  if (!browsePath) return;
  if (pick) { pick(browsePath); return; }
  $('pathInput').value = browsePath;
  startScan(browsePath);
});

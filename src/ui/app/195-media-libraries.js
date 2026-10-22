/* ═══════════ Media libraries (v4 §8.1) ═══════════
   Photos, Final Cut, iMovie, Lightroom, Capture One — the largest single
   objects on many disks, and opaque bundles. The same deal as games: split
   into originals / derivatives / database from each library's OWN documented
   layout, and only DERIVATIVES ever get a cart button, each stating what
   regenerating it will cost. Originals never do — the file IS the data. A
   bundle whose layout is unrecognised shows its total size and offers
   nothing; a library its app is holding open says so and offers nothing. */
const MEDIA_PART = {
  originals: { label: 'Originals', hint: 'The photos and footage themselves. Never offered for removal — the file is the data.' },
  derivatives: { label: 'Derivatives', hint: 'Renders, proxies, thumbnails, previews — the app rebuilds these.' },
  database: { label: 'Database', hint: 'The library catalog. Removing it loses edits and organisation.' },
};

async function loadMedia(force = false) {
  if (!state.root) return;
  const host = $('mediaBody');
  // Asked of the scan the tree on screen came from (treeScanId), never a scan
  // still walking (409); the saved index's tree has none, and says so (BQJ-1b).
  const scanId = treeScanId();
  if (!scanId) {
    state.media.report = null;
    state.media.loadedFor = null;
    $('mediaInfo').textContent = '';
    host.innerHTML = `<div class="muted">${escapeHtml(treeScanComing()
      ? 'Photo and video libraries are read from a finished scan — this fills in once the scan finishes.'
      : 'Opened from the saved index — scan this folder to see its photo and video libraries.')}</div>`;
    return;
  }
  if (!force && state.media.loadedFor === scanId) { renderMedia(); return; }
  host.innerHTML = skeletonRows(4, 42, 'Reading photo and video libraries…');
  if (typeof sayWorking === 'function') sayWorking(host, 'mediaWorking');
  $('mediaInfo').textContent = '';
  try {
    const report = await api('/api/media?scanId=' + scanId);
    if (treeScanId() !== scanId) return; // another tree is on screen now; its own load paints
    state.media.report = report;
    state.media.loadedFor = scanId;
    renderMedia();
  } catch (e) {
    if (treeScanId() !== scanId) return;
    state.media.report = null;
    host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}

function renderMedia() {
  const host = $('mediaBody');
  const report = state.media.report;
  if (!report) return;
  const libs = report.libraries || [];
  if (!libs.length) {
    $('mediaInfo').textContent = '';
    host.innerHTML = `<div class="muted" style="display:flex;align-items:center;gap:8px;padding:10px 2px;">${icon('image', 15)}
      No Photos, Final Cut, iMovie, Lightroom or Capture One library was found in this scan.</div>`;
    return;
  }
  // Keyed by scan, like the games line: same scan rolls, new scan snaps.
  FxNum.rollHtml($('mediaInfo'),
    `<b>${formatCount(libs.length)}</b> ${libs.length === 1 ? 'library' : 'libraries'} — <b>${formatBytes(report.totalBytes || 0)}</b>` +
    (report.derivativesBytes ? `, of which <b>${formatBytes(report.derivativesBytes)}</b> is regenerable derivatives` : ''), state.media.loadedFor);
  host.innerHTML = libs.map((lib) => {
    const head = `
      <div class="game-libhead">
        <b>${escapeHtml(lib.appName || lib.kind)}</b>
        <span class="pth" title="${escapeHtml(lib.path)}">${escapeHtml(lib.path)}</span>
        <span class="size-badge num" style="color:${sizeInk(lib.totalBytes)}">${formatBytes(lib.totalBytes)}</span>
      </div>`;
    // An unrecognised layout gets its size and an explanation — never a guess
    // at which parts are safe.
    if (lib.recognised === false) {
      return `<div class="game-lib">${head}
        <div class="muted" style="padding:4px 2px;">${escapeHtml(lib.reason || 'This library version is not recognised — shown for its size only.')}</div>
      </div>`;
    }
    // A library its app is holding open is looked at, not touched.
    const heldBy = lib.inUse && lib.inUse.held ? ((lib.inUse.processNames || []).join(', ') || 'a running app') : null;
    const held = heldBy
      ? `<div class="muted" style="padding:4px 2px;">${icon('alert', 13)} ${escapeHtml(`${heldBy} is running and holding this library — nothing is offered while it is open.`)}</div>`
      : lib.inUse && lib.inUse.checked === false
        ? `<div class="muted" style="padding:4px 2px;">${icon('alert', 13)} ${escapeHtml(lib.inUse.reason || 'Whether the owning app is holding this library could not be checked — deleting re-checks before anything moves.')}</div>`
        : '';
    const comps = lib.components || [];
    const parts = comps.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + c.bytes; return m; }, {});
    const bar = Object.keys(MEDIA_PART).filter((k) => parts[k] > 0).map((k) =>
      `<span class="gp gp-${k === 'originals' ? 'base' : k === 'derivatives' ? 'shaderCache' : 'workshop'}" style="width:${((parts[k] / Math.max(1, lib.totalBytes)) * 100).toFixed(2)}%"
        title="${escapeHtml(MEDIA_PART[k].label)} — ${escapeHtml(formatBytes(parts[k]))}. ${escapeHtml(MEDIA_PART[k].hint)}"></span>`).join('');
    const legend = Object.keys(MEDIA_PART).filter((k) => parts[k] > 0)
      .map((k) => `<span class="gl"><i class="gp-${k === 'originals' ? 'base' : k === 'derivatives' ? 'shaderCache' : 'workshop'}"></i>${escapeHtml(MEDIA_PART[k].label)} ${formatBytes(parts[k])}</span>`).join('');
    const rows = heldBy ? '' : comps
      .filter((c) => c.removable && c.bytes > 0)
      .map((c) => `
        <div class="game-shader">
          <span class="gl"><i class="gp-shaderCache"></i>${escapeHtml(c.label || MEDIA_PART[c.kind].label)}</span>
          <span class="pth" title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</span>
          <span class="muted">${escapeHtml(c.regenerationCost || '')}</span>
          <span class="size-badge num">${formatBytes(c.bytes)}</span>
          ${cartButtonHtml(c.path, `${c.label || MEDIA_PART[c.kind].label} of ${lib.appName || lib.kind}`)}
        </div>`).join('');
    return `<div class="game-lib">${head}${held}
      <div class="game-bar">${bar}</div>
      <div class="game-legend">${legend}</div>
      ${rows ? `<div class="game-shaders">${rows}</div>` : ''}
    </div>`;
  }).join('');
  refreshCartButtons();
}

async function loadGames(force = false) {
  if (!state.root) return;
  const host = $('gamesBody');
  // As loadMedia: the tree's scan (treeScanId), or why there is none (BQJ-1b).
  const scanId = treeScanId();
  if (!scanId) {
    state.games.report = null;
    state.games.loadedFor = null;
    $('gamesInfo').textContent = '';
    host.innerHTML = `<div class="muted">${escapeHtml(treeScanComing()
      ? 'Game libraries are read from a finished scan — this fills in once the scan finishes.'
      : 'Opened from the saved index — scan this folder to see its game libraries.')}</div>`;
    return;
  }
  if (!force && state.games.loadedFor === scanId) { renderGames(); return; }
  host.innerHTML = skeletonRows(6, 42, 'Reading game libraries…');
  if (typeof sayWorking === 'function') sayWorking(host, 'gamesWorking');
  $('gamesInfo').textContent = '';
  try {
    const report = await api('/api/games?scanId=' + scanId);
    if (treeScanId() !== scanId) return; // another tree is on screen now; its own load paints
    state.games.report = report;
    state.games.loadedFor = scanId;
    renderGames();
  } catch (e) {
    if (treeScanId() !== scanId) return;
    state.games.report = null;
    host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}

function renderGames() {
  const host = $('gamesBody');
  const report = state.games.report;
  if (!report) return;
  if (!report.libraries.length) {
    $('gamesInfo').textContent = '';
    host.innerHTML = `<div class="muted" style="display:flex;align-items:center;gap:8px;padding:10px 2px;">${icon('play', 15)}
      No Steam, Epic, GOG or itch.io library was found in this scan. Scan the drive your games are installed on to see them here.</div>`;
    return;
  }
  // Keyed by scan: clearing shader caches re-reports the same scan, and
  // the freed bytes roll down in place.
  FxNum.rollHtml($('gamesInfo'),
    `<b>${formatCount(report.titleCount)}</b> ${report.titleCount === 1 ? 'title' : 'titles'} across ` +
    `${formatCount(report.libraries.length)} ${report.libraries.length === 1 ? 'library' : 'libraries'} — <b>${formatBytes(report.totalBytes)}</b>` +
    (report.shaderCacheBytes
      ? `, of which <b>${formatBytes(report.shaderCacheBytes)}</b> is shader cache
         <button class="pill" id="clearShadersBtn">${icon('sparkles', 13)} Clear shader caches safely</button>`
      : ''), state.games.loadedFor);

  host.innerHTML = report.libraries.map(lib => `
    <div class="game-lib">
      <div class="game-libhead">
        <b>${escapeHtml(LAUNCHER_LABEL[lib.launcher] || lib.launcher)}</b>
        <span class="pth">${escapeHtml(lib.path)}</span>
        <span class="size-badge num" style="color:${sizeInk(lib.totalBytes)}">${formatBytes(lib.totalBytes)}</span>
      </div>` + lib.titles.map(t => {
        const parts = t.components.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + c.bytes; return m; }, {});
        const bar = Object.keys(GAME_PART).filter(k => parts[k] > 0).map(k =>
          `<span class="gp gp-${k}" style="width:${(parts[k] / Math.max(1, t.totalBytes) * 100).toFixed(2)}%"
             title="${escapeHtml(GAME_PART[k].label)} — ${escapeHtml(formatBytes(parts[k]))}. ${escapeHtml(GAME_PART[k].hint)}"></span>`).join('');
        const legend = Object.keys(GAME_PART).filter(k => parts[k] > 0)
          .map(k => `<span class="gl"><i class="gp-${k}"></i>${escapeHtml(GAME_PART[k].label)} ${formatBytes(parts[k])}</span>`).join('');
        // Only Steam records a size of its own; show the gap when there is one
        // rather than quietly presenting our number as theirs.
        const vsLauncher = t.reportedBytes
          ? `<span class="game-vs" title="${escapeHtml(LAUNCHER_LABEL[t.launcher] || t.launcher)} records ${escapeHtml(formatBytes(t.reportedBytes))} for the install itself">${
              t.reportedDelta !== undefined && t.reportedDelta < 0.02
                ? `matches ${escapeHtml(LAUNCHER_LABEL[t.launcher])}`
                : `${escapeHtml(LAUNCHER_LABEL[t.launcher])} says ${formatBytes(t.reportedBytes)}`}</span>`
          : '';
        return `
      <div class="game-title">
        <div class="game-head">
          <div class="meta">
            <div class="nm">${escapeHtml(t.name)}</div>
            <div class="pth">${escapeHtml(t.installPath)}</div>
          </div>
          ${vsLauncher}
          ${t.updatedAt ? `<span class="dt num">${formatDate(t.updatedAt)}</span>` : ''}
          <span class="size-badge num">${formatBytes(t.totalBytes)}</span>
        </div>
        <div class="game-bar">${bar}</div>
        <div class="game-legend">${legend}${t.dlcInsideBase && !parts.dlc
          ? '<span class="gl muted">DLC is installed inside the game — Steam does not separate it</span>' : ''}</div>
        ${gameCartRows(t)}
      </div>`;
      }).join('') + `</div>`).join('');

  const btn = $('clearShadersBtn');
  if (btn) btn.addEventListener('click', clearShaderCaches);
  // Staged shader caches must show as staged the moment the view repaints —
  // the delegated click handler sets state, this reflects it.
  refreshCartButtons();
}

/**
 * Clear every shader cache. Trash-only and confirmed, through the same path as
 * every other delete — and it states the cost up front, because a game that
 * stutters for a minute after an unexplained cleanup reads as a broken game.
 */
function clearShaderCaches() {
  const report = state.games.report;
  if (!report) return;
  const paths = [];
  let bytes = 0;
  for (const lib of report.libraries) {
    for (const t of lib.titles) {
      for (const c of t.components) {
        if (c.kind === 'shaderCache') { paths.push(c.path); bytes += c.bytes; }
      }
    }
  }
  if (!paths.length) { toast('No shader caches to clear'); return; }
  $('confirmTitle').innerHTML = icon('sparkles', 18) + 'Clear shader caches?';
  // The Trash holds them until it is emptied: nothing is freed before (D54; review F2.3 of QA third pass D06).
  $('confirmText').innerHTML =
    `Move <b>${paths.length}</b> shader ${paths.length === 1 ? 'cache' : 'caches'} (<b>${formatBytes(bytes)}</b>) to the Trash. The space comes back when you empty the Trash.<br>` +
    `<span style="color:var(--text-3)">Shaders are recompiled automatically. <b>Each affected game will stutter once</b> while it rebuilds them on the next launch — after that it is back to normal. Nothing else about the games is touched.</span>`;
  onConfirmTrash = async () => {
    await trashPaths(paths);
    // A rescan is what re-measures the tree; the panel then reloads from it.
    rescan();
  };
  $('confirmModal').classList.add('open');
}

/**
 * Which of an app's locations may be staged for deletion (v4 §4.2).
 *
 * Cache and logs — the same two categories "Clear caches safely" has always
 * meant, and the same set `safeToClearPaths` is built from. Deliberately NOT
 * `app` or `data`: an app bundle and a user's documents are the thing itself,
 * not a rebuildable copy of it, and a per-row + button beside them would offer
 * a one-click permanent-feeling delete of something no rule ever suggested.
 *
 * §4.2's "cache components only" is a safety guarantee written as a rendering
 * rule, so `tests/cleanupCart.test.ts` asserts this set by name.
 */
const APP_CART_CATEGORIES = new Set(['cache', 'logs']);

/** Short per-category summary for an app's header row, e.g. "caches 1.2 GB · data 3.4 GB".
    One category is named alone — "app only" — because its size is the row's
    total, which the badge already shows: every row printed it twice (design
    pass G24). */
function appCatSummary(app) {
  const parts = ['app', 'cache', 'data', 'logs'].filter(c => app.bytesByCategory[c] > 0);
  if (parts.length === 1) return `${APP_CAT_LABEL[parts[0]].toLowerCase()} only`;
  return parts
    .map(c => `${APP_CAT_LABEL[c].toLowerCase()} ${formatBytes(app.bytesByCategory[c])}`)
    .join(' · ');
}

function renderApps() {
  const host = $('appsBody');
  const apps = state.apps.list;
  const attributed = state.apps.totalBytes - state.apps.otherBytes;
  const hint = !state.apps.appsFolderScanned && apps.length
    ? ' The system-wide applications folder wasn’t inside this scan — scan the whole disk to count the apps themselves.'
    : '';
  // Keyed by scan: a repaint of the same scan rolls the totals, a new scan
  // (or a different folder in the path sentence) snaps.
  FxNum.rollHtml($('appsInfo'), state.root
    ? `Based on your scan of <b>${escapeHtml(state.root.path)}</b>` +
      (apps.length ? ` — <span class="num">${apps.length}</span> apps own <span class="num">${formatBytes(attributed)}</span> of ${formatBytes(state.apps.totalBytes)}.${hint}` : '.')
    : '', state.apps.loadedFor);
  if (!apps.length) {
    appsScatterDrop();
    host.innerHTML = `<div class="muted" style="display:flex;align-items:center;gap:8px;padding:12px 2px;">${icon('search', 15)} No application folders inside this scan — scan your home folder or the whole disk to see per-app storage.</div>`;
    return;
  }
  void loadAppsScatter();
  const max = apps[0].totalBytes || 1;
  host.innerHTML = apps.map((a, i) => `
    <div class="bp-acc app-acc" data-acc="${i}">
      <div class="bp-head" role="button" tabindex="0" aria-expanded="false">
        <span class="chip" style="--tint:#5E5CE6">${icon('box', 15)}</span>
        <span class="bp-title">${escapeHtml(a.name)}<span class="prof">${appCatSummary(a)}</span></span>
        <span class="spacer"></span>
        ${a.safeToClearBytes >= MB ? `<button class="pill app-clear" data-i="${i}" title="Move this app's caches and logs to the Trash — never its data or the app itself">Clear ${formatBytes(a.safeToClearBytes)} safely</button>` : ''}
        <div class="bar-track"><div class="fx-bar-fill" data-w="${Math.max(4, (a.totalBytes / max) * 100).toFixed(1)}" style="${fxBarStyle(i)}"></div></div>
        <span class="size-badge num" style="color:${sizeInk(a.totalBytes)}">${formatBytes(a.totalBytes)}</span>
        <span class="chev">${icon('chevronRight', 14)}</span>
      </div>
      <div class="bp-items">` + a.locations.map(loc => `
        <div class="bp-item" role="button" tabindex="0" data-jump="${escapeHtml(loc.path)}" title="Show ${escapeHtml(loc.path)} in the treemap — right-click for actions">
          <span class="cat">${APP_CAT_LABEL[loc.category]}</span>
          <span class="lbl">${escapeHtml(loc.path)}</span>
          <span class="size-badge num" style="color:${sizeInk(loc.bytes)}">${formatBytes(loc.bytes)}</span>
          ${APP_CART_CATEGORIES.has(loc.category)
            ? cartButtonHtml(loc.path, loc.path)
            : `<span class="adv-spacer" title="${escapeHtml(APP_CAT_LABEL[loc.category])} — this is the app or your own data, not a rebuildable cache, so TreeMap does not offer to stage it"></span>`}
        </div>`).join('') + `
      </div>
    </div>`).join('') + `
    <div class="bp-acc other-row">
      <div class="bp-head" tabindex="-1">
        <span class="chip" style="--tint:#8E8E93">${icon('file', 15)}</span>
        <span class="bp-title">Everything else<span class="prof">files not owned by any application</span></span>
        <span class="spacer"></span>
        <div class="bar-track"><div class="fx-bar-fill" data-w="${Math.max(4, (state.apps.otherBytes / max) * 100).toFixed(1)}" style="${fxBarStyle(3)}"></div></div>
        <span class="size-badge num" style="color:${sizeInk(state.apps.otherBytes)}">${formatBytes(state.apps.otherBytes)}</span>
      </div>
    </div>`;

  host.querySelectorAll('.app-acc .bp-head').forEach(head => {
    const toggle = () => { const a = head.closest('.bp-acc'); head.setAttribute('aria-expanded', String(a.classList.toggle('open'))); };
    head.addEventListener('click', (e) => { if (e.target.closest('button')) return; toggle(); });
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  host.querySelectorAll('.app-clear').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const app = state.apps.list[+btn.dataset.i];
    if (app && app.safeToClearPaths.length) confirmTrash(app.safeToClearPaths);
  }));
  host.querySelectorAll('[data-jump]').forEach(row => {
    const jump = () => {
      state.treemap.rootPath = row.dataset.jump;
      switchView('treemap');
    };
    row.addEventListener('click', (e) => { if (e.target.closest('button')) return; jump(); });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); } });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = row.dataset.jump;
      const node = state.pathIndex.get(p) ||
        { path: p, name: p.split(/[\\/]/).pop() || p, type: 'dir', modifiedAt: 0 };
      showCtxMenu(e.clientX, e.clientY, node);
    });
  });
  fxBarsIn(host); // the per-app kit bars
  refreshCartButtons();
}

/* ── The apps scatter (bklit offset-ring dots, yGradient) ──
   Size against file count, one dot per application. File counts come from
   the same subtreeCount fact Disk City uses — real per-path counts from the
   full scan store, summed over the app's listed locations. An app with a
   location the provider could not count gets no dot: unknown is not zero.
   Five apps is the floor — fewer make a legend, not a scatter. */
let appsScatterHandle = null;
let appsScatterSeq = 0;
function appsScatterDrop() {
  appsScatterSeq++; // an in-flight fact fetch must not resurrect the chart
  if (appsScatterHandle) { appsScatterHandle.destroy(); appsScatterHandle = null; }
  const wrap = $('appsScatter');
  if (wrap) wrap.hidden = true;
}
async function loadAppsScatter() {
  const apps = state.apps.list;
  // Asked of the scan the tree on screen came from (treeScanId), whose apps
  // these are (loadApps) — never a scan still walking (BQJ-1b).
  const scanId = treeScanId();
  const seq = ++appsScatterSeq;
  if (!scanId || apps.length < 5) { appsScatterDrop(); return; }
  let values = null;
  try {
    // Bounded well under the fact route's 2000-path cap: apps are capped at
    // 12 locations each and the list itself is short.
    const paths = apps.flatMap((a) => a.locations.map((l) => l.path)).slice(0, 2000);
    const res = await api('/api/facts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId, paths, providers: ['subtreeCount'] }),
    });
    const provider = res.providers && res.providers.subtreeCount;
    values = (provider && provider.available && provider.values) || null;
  } catch { values = null; }
  if (seq !== appsScatterSeq || treeScanId() !== scanId) return; // superseded
  if (!values) { appsScatterDrop(); return; }
  const points = [];
  for (const a of apps) {
    let files = 0, known = a.locations.length > 0;
    for (const l of a.locations) {
      // The provider answers { files, dirs } per path; absence means "could
      // not count", which voids the whole app's dot — unknown is not zero.
      const v = values[l.path];
      if (v && Number.isFinite(v.files)) files += v.files;
      else { known = false; break; }
    }
    if (known) points.push({ x: files, y: a.totalBytes, label: a.name });
  }
  if (points.length < 5) { appsScatterDrop(); return; }
  $('appsScatter').hidden = false;
  const spec = {
    points, height: 200, yGradient: true,
    // ~300 apps span five decades in both size and count; linear axes pile
    // them into one blob at the origin. Ticks: count decades and byte
    // decades — base 1000, because sizes are decimal (1 GB = 10^9 bytes, the
    // owner's choice in QA D09), so every label prints a round 1.0 KB → MB → GB.
    logX: 10, logY: 1000,
    formatX: (v) => `${formatCount(Math.round(v))} files`,
    formatY: formatBytes,
  };
  if (appsScatterHandle) appsScatterHandle.update(spec);
  else appsScatterHandle = FxCharts.scatter($('appsScatterChart'), spec);
}

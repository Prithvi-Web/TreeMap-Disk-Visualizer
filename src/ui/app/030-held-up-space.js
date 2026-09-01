/* ───────────────────────────── Held-up space (B5) ─────────────────────────────
   A file deleted while a program still has it open keeps its blocks until
   that program lets go — which is how a disk fills up with nothing visible
   to account for it. No signal short of the process exiting frees the space,
   so the row action is "restart it": a polite quit (never forced), reopened
   automatically where that is genuinely supported (Mac apps, via `open`). */

let zombiesLoading = false;
/** The processes behind the rendered rows, so a click needs no data baked into HTML. */
let zombieProcs = [];
/** Rows shown before the rest fold behind "show more". */
const ZH_VISIBLE_ROWS = 8;

async function loadZombies() {
  const body = $('zombieBody');
  if (!body || zombiesLoading) return;

  // Same shortcut as the topology card: when the capability answer is already
  // here and negative, render the honest reason without a doomed request.
  const cap = state.capabilities && state.capabilities.zombieHandles;
  if (cap && !cap.available) { renderZombiesBlocked(cap.reason); return; }

  zombiesLoading = true;
  // Loading (§3.5) — except on refresh, where blanking a populated card would
  // read as data vanishing; the veil sweeps the standing rows instead, and
  // every painter settles it.
  if (!body.querySelector('.zh-row') && !body.querySelector('.zh-total')) {
    body.innerHTML = skeletonRows(2, 26, 'Checking for held-up space…');
  } else {
    body.classList.add('fx-chart-loading');
  }
  try {
    const report = await api('/api/zombie-handles');
    renderZombies(report);
  } catch (err) {
    if (err.capabilityUnavailable) renderZombiesBlocked(err.message);
    else renderZombiesError(err);
  } finally {
    zombiesLoading = false;
  }
}

/** Unavailable (§3.5 state 5): the specific reason, presented as an answer. */
function renderZombiesBlocked(reason) {
  zombieProcs = [];
  $('zombieBody').classList.remove('fx-chart-loading');
  $('zombieBody').innerHTML =
    `<div class="muted" style="display:flex;gap:8px;align-items:flex-start;padding:4px 2px;">${icon('alert', 14)}` +
    `<span style="line-height:1.5;">${escapeHtml(reason || 'Held-space detection is not available on this computer.')}</span></div>`;
}

/** Error (§3.5 state 6): the envelope's message, with a retry. */
function renderZombiesError(err) {
  zombieProcs = [];
  $('zombieBody').classList.remove('fx-chart-loading');
  $('zombieBody').innerHTML =
    `<div class="muted" style="padding:4px 2px;">Couldn’t check for held-up space: ${escapeHtml(err.message || 'something went wrong.')}</div>` +
    `<button class="pill topo-more" data-zh-retry="1">Try again</button>`;
  wireZombieActions();
}

function renderZombies(report) {
  const body = $('zombieBody');
  body.classList.remove('fx-chart-loading'); // every paint settles the veil
  zombieProcs = report.processes || [];

  if (!zombieProcs.length) {
    // Empty (§3.5 state 1) — and here empty is the good news, so it says so
    // rather than looking like a panel with nothing to offer.
    body.innerHTML = `<div class="muted" style="padding:4px 2px;">Nothing is stuck — no deleted files are being held open right now.</div>`;
    return;
  }

  const atLeast = report.unknownSizeCount > 0 ? 'At least ' : '';
  const holders = zombieProcs.length === 1 ? 'a program that won’t let go' : `${zombieProcs.length} programs that won’t let go`;
  const head = `<div class="zh-total num">${atLeast}${formatBytes(report.totalBytes)} held by ${holders}</div>`;

  // The kit's bar recipe against the biggest holder, so the eye ranks the
  // rows before the digits do. A holder whose size could not be read gets
  // no bar at all — an empty track would read as "zero bytes", which is a
  // different claim from "unknown".
  const maxHeld = zombieProcs.reduce((m, p) => Math.max(m, p.bytes), 0);
  const rows = zombieProcs.map((p, i) => {
    const held = p.bytes > 0
      ? formatBytes(p.bytes) + (p.unknownSizeCount ? '+' : '')
      : (p.unknownSizeCount ? 'size unknown' : formatBytes(0));
    const files = p.handles.slice(0, 3).map(h => baseName(h.path)).join(', ')
      + (p.handles.length > 3 ? ` and ${p.handles.length - 3} more` : '');
    const bar = p.bytes > 0 && maxHeld > 0
      ? `<span class="fx-bar-track"><span class="fx-bar-fill" data-w="${Math.max(3, (p.bytes / maxHeld) * 100).toFixed(1)}" style="${fxBarStyle(i)}"></span></span>`
      : '';
    return `<div class="zh-row"${i >= ZH_VISIBLE_ROWS ? ' hidden' : ''}>` +
      `<span class="nm" title="Holding: ${escapeHtml(files)}">${escapeHtml(p.processName)}</span>` +
      `<span class="pid num">pid ${p.pid}</span>` +
      bar +
      `<b class="sz num">${held}</b>` +
      `<button class="pill" data-zh-restart="${i}" title="Ask it to quit so the space frees${p.appBundle ? ', then reopen it' : ''}">Restart</button>` +
      `</div>`;
  }).join('');

  // A browser alone can hold hundreds of unlinked cache files (measured: 330
  // holders on this Mac, most of them a few MB) — so the tail folds behind
  // the same show-more pattern the topology card uses, biggest first.
  const foldedCount = Math.max(0, zombieProcs.length - ZH_VISIBLE_ROWS);
  const foldedBytes = zombieProcs.slice(ZH_VISIBLE_ROWS).reduce((s, p) => s + p.bytes, 0);
  const more = foldedCount
    ? `<button class="pill topo-more" data-zh-toggle="1" data-more="Show ${foldedCount} more · ${formatBytes(foldedBytes)}" data-less="Show fewer" aria-expanded="false">Show ${foldedCount} more · ${formatBytes(foldedBytes)}</button>`
    : '';

  const note = report.unknownSizeCount > 0
    ? `<div class="zh-note">${report.unknownSizeCount} held file${report.unknownSizeCount === 1 ? '’s size' : 's’ sizes'} couldn’t be read, so the real total is higher.</div>`
    : '';
  // A refresh of the same machine's holders rolls the totals in place; any
  // change in WHO is holding shifts the statics, which FxNum snaps on.
  FxNum.rollHtml(body, head + rows + more + note, 'zh');
  fxBarsIn(body);
  wireZombieActions();
}

function wireZombieActions() {
  const body = $('zombieBody');
  body.querySelectorAll('[data-zh-retry]').forEach((b) => b.addEventListener('click', () => loadZombies()));
  body.querySelectorAll('[data-zh-restart]').forEach((b) => b.addEventListener('click', () => {
    const p = zombieProcs[Number(b.dataset.zhRestart)];
    if (p) confirmZombieRestart(p);
  }));
  body.querySelectorAll('[data-zh-toggle]').forEach((b) => b.addEventListener('click', () => {
    const open = b.getAttribute('aria-expanded') === 'true';
    body.querySelectorAll('.zh-row').forEach((row, i) => {
      if (i >= ZH_VISIBLE_ROWS) row.hidden = open;
    });
    b.setAttribute('aria-expanded', String(!open));
    b.textContent = open ? b.dataset.more : b.dataset.less;
  }));
}

/**
 * The restart confirmation. §B5 requires the unsaved-work warning to be
 * explicit, and it differs honestly by what happens next: a Mac app is
 * reopened automatically; anything else must be started again by hand.
 */
function confirmZombieRestart(p) {
  resetOpenHandleWarning(); // clear any leftover B2 panel from a delete dialog
  onConfirmTrash = async () => {
    try {
      const res = await api('/api/zombie-handles/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: p.pid, processName: p.processName }),
      });
      toast(res.message, res.terminated ? 'success' : 'error', 8000);
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
    loadZombies();
  };
  $('confirmTitle').innerHTML = icon('refresh', 18) + `Restart ${escapeHtml(p.processName)}?`;
  $('confirmText').innerHTML = p.appBundle
    ? `TreeMap will ask <b>${escapeHtml(p.processName)}</b> to quit, then open it again. The space it is holding frees when it quits.` +
      `<br><span style="color:var(--text-3)">If it has unsaved work it may ask you to save first — nothing is ever force-quit.</span>`
    : `TreeMap will ask <b>${escapeHtml(p.processName)}</b> to quit. <b>If it has unsaved work, that work could be lost.</b>` +
      `<br><span style="color:var(--text-3)">You’ll need to start it again yourself — TreeMap can only reopen Mac apps automatically.</span>`;
  $('confirmOk').innerHTML = icon('refresh', 15) + 'Restart it';
  $('confirmModal').classList.add('open');
}

$('zombieRefresh').addEventListener('click', () => loadZombies());
subscribe(TOPIC.capabilities, () => loadZombies());

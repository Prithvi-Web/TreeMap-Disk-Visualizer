/* ───────────────────────────── Folder budgets (Feature 15) ───────────────────────────── */
function budgetFor(path) { return state.budgets.list.find(b => b.path === path) || null; }

let loadBudgetsSeq = 0;
/** Fetch budgets for the current scan, update the dashboard widget + treemap overlay. */
async function loadBudgets() {
  if (!state.scanId || !state.root) return;
  // FX: a reload sweeps the existing gauges instead of blanking them; a
  // first paint has no card to veil (renderBudgetWidget hides it empty).
  if (!$('budgetCard').hidden) $('budgetList').classList.add('fx-chart-loading');
  try {
    const data = await api(`/api/scan/${state.scanId}/budgets`);
    state.budgets.list = data.budgets || [];
    // The server measured these folders exactly; seed them so the edit dialog
    // can state a real size even when the folder itself was pruned away.
    seedNodes(state.budgets.list.map((b) => ({ path: b.path, name: b.name, size: b.actualBytes, type: 'dir' })));
  } catch { state.budgets.list = []; }
  state.budgets.overPaths = new Set(state.budgets.list.filter(b => b.overBy > 0).map(b => b.path));
  // v4 §9.4 — the breach projections ride a separate endpoint (the budgets
  // response is byte-locked). Failing to load them costs the projection line,
  // never the meter: the widget renders from the list either way. The seq
  // guard is the same one every type-ahead here carries: two overlapping
  // loads (a rescan racing a budget save) must not let the older scan's
  // projections land on the newer scan's list.
  const seq = ++loadBudgetsSeq;
  state.budgets.gauges = new Map();
  renderBudgetWidget();
  try {
    const g = await api(`/api/scan/${state.scanId}/budget-gauges`);
    if (seq !== loadBudgetsSeq) return;
    state.budgets.gauges = new Map((g.gauges || []).map((x) => [x.path, x]));
    renderBudgetWidget();
  } catch { /* the meter alone is still a true statement */ }
  // The sunburst has no budget-border pass; the other three do.
  if (state.view === 'treemap' && !isSun()) presentView();
}

/**
 * One line of projection under a budget bar (v4 §9.4).
 *
 * 'ok' names the date; every other status is the forecast's own refusal,
 * shown rather than swallowed — a thermometer with no projection and no
 * stated reason would read as a broken feature, and a projection invented
 * from thin history would be worse. Ancestor-tree series carry their caveat
 * in a title so the approximation is one hover away.
 */
function budgetProjectionLine(b) {
  const gauge = state.budgets.gauges && state.budgets.gauges.get(b.path);
  if (!gauge || !gauge.projection) return '';
  const p = gauge.projection;
  if (p.status === 'over' || b.overBy > 0) return ''; // the red label above already says it
  if (p.status === 'ok' && typeof p.breachInDays === 'number') {
    const days = Math.round(p.breachInDays);
    const when = new Date(p.breachAtMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const approx = p.seriesSource === 'ancestor-trees'
      ? ` <span title="${escapeHtml(p.caveat || '')}">· from shallow history</span>` : '';
    return `<div class="muted num" style="font-size:10.5px;" title="${escapeHtml(formatBytes(p.bytesPerDay))}/day over ${Number(p.seriesPoints) || 0} scans">` +
      `at this pace, over in ~${days} day${days === 1 ? '' : 's'} (${escapeHtml(when)})${approx}</div>`;
  }
  return `<div class="muted" style="font-size:10.5px;" title="${escapeHtml(p.reason || '')}">${escapeHtml(shortProjectionReason(p))}</div>`;
}

/** The refusal, compressed to fit a dashboard row; the full reason is the title. */
function shortProjectionReason(p) {
  if (p.status === 'insufficient') return 'no projection yet — needs more scan history';
  if (p.status === 'erratic') return 'growth too erratic to project honestly';
  if (p.status === 'shrinking') return 'shrinking — no breach in sight';
  if (p.status === 'stable') return 'flat — no breach in sight';
  return p.reason || '';
}

/* Every gauge canvas the widget currently owns. Destroy-before-innerHTML is
   mandatory: a rebuilt list would otherwise strand live handles (rAF eases,
   ResizeObservers) on detached canvases. */
const budgetGauges = [];
function fxBudgetGaugesDrop() {
  for (const g of budgetGauges) g.destroy();
  budgetGauges.length = 0;
}
function renderBudgetWidget() {
  const card = $('budgetCard'), list = $('budgetList');
  if (!card || !list) return;
  list.classList.remove('fx-chart-loading'); // every paint settles the veil
  fxBudgetGaugesDrop();
  const items = state.budgets.list;
  if (!items.length) { card.hidden = true; list.innerHTML = ''; return; }
  card.hidden = false;
  // Over-budget first (already sorted by overBy desc from the API).
  list.innerHTML = items.map(b => {
    const over = b.overBy > 0;
    const label = over
      ? `over by ${formatBytes(b.overBy)}`
      : `${formatBytes(b.maxBytes - b.actualBytes)} left`;
    return `<div class="budget-row ${over ? 'is-over' : 'is-ok'}" data-budget-path="${escapeHtml(b.path)}">
      <canvas class="budget-gauge" width="56" height="56" aria-hidden="true"></canvas>
      <div class="meta">
        <div class="nm" title="${escapeHtml(b.path)}">${escapeHtml(b.name)}</div>
        ${budgetProjectionLine(b)}
      </div>
      <div style="text-align:right;">
        <div class="over">${over ? icon('alert', 12) + ' ' : ''}${label}</div>
        <div class="muted num" style="font-size:10.5px;">${formatBytes(b.actualBytes)} / ${formatBytes(b.maxBytes)}</div>
      </div>
      <button class="icon-btn b-edit" data-budget-edit="${escapeHtml(b.path)}" title="Edit budget" aria-label="Edit budget for ${escapeHtml(b.name)}">${icon('gauge', 14)}</button>
    </div>`;
  }).join('');
  // The linear bar's job moved to the gauge; the sentences above stay — they
  // are the honesty contract, the gauge is only the shape of them.
  list.querySelectorAll('canvas.budget-gauge').forEach((cv, i) => {
    const b = items[i];
    budgetGauges.push(FxCharts.gauge(cv, {
      value: b.maxBytes > 0 ? b.actualBytes / b.maxBytes : 1,
      size: 56, notches: 28, danger: b.overBy > 0,
      // The accent ramp per notch; danger overrides it whole — an over-budget
      // gauge stays solid red, never a prettier gradient of the same fact.
      activeGradient: FxCharts.ramp(2),
    }));
  });
  list.querySelectorAll('[data-budget-edit]').forEach(btn => btn.addEventListener('click', () => {
    const node = nodeFor(btn.dataset.budgetEdit);
    openBudgetDialog(node || { path: btn.dataset.budgetEdit, name: btn.dataset.budgetEdit.split('/').pop() || btn.dataset.budgetEdit, type: 'dir', size: null });
  }));
}

let budgetTarget = null;
function openBudgetDialog(node) {
  if (!node) return;
  budgetTarget = node;
  const existing = budgetFor(node.path);
  $('budgetFolderName').textContent = node.name || node.path;
  $('budgetFolderPath').textContent = node.path;
  const size = (typeof node.size === 'number') ? node.size : (nodeFor(node.path)?.size ?? null);
  $('budgetCurrent').innerHTML = size != null
    ? `Current size: <b>${formatBytes(size)}</b>`
    : 'Current size unknown until the next scan.';
  // Prefill with the existing budget (pick the friendliest unit) or a sensible default.
  const unitSel = $('budgetUnit'), valIn = $('budgetValue');
  if (existing) {
    const unit = existing.maxBytes % 1073741824 === 0 ? 1073741824
      : existing.maxBytes % 1048576 === 0 ? 1048576
      : existing.maxBytes % 1024 === 0 ? 1024 : 1;
    unitSel.value = String(unit);
    valIn.value = String(existing.maxBytes / unit);
  } else {
    unitSel.value = '1073741824';
    valIn.value = '';
  }
  $('budgetRemoveBtn').style.display = existing ? '' : 'none';
  $('budgetModal').classList.add('open');
  setTimeout(() => valIn.focus(), 30);
}

/** Persist the full budget list (merge/replace one path) via PUT /api/settings. */
async function saveBudgetList(nextBudgets) {
  const data = await api('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ budgets: nextBudgets }),
  });
  return data.budgets || [];
}

/** Read the full saved budget list (all paths, not just this scan's). */
async function currentSavedBudgets() {
  try {
    const s = await api('/api/settings');
    return (s.budgets || []).map(b => ({ path: b.path, maxBytes: b.maxBytes }));
  } catch {
    return state.budgets.list.map(b => ({ path: b.path, maxBytes: b.maxBytes }));
  }
}

async function commitBudget() {
  if (!budgetTarget) return;
  const value = parseFloat($('budgetValue').value);
  const unit = Number($('budgetUnit').value);
  if (!Number.isFinite(value) || value <= 0) { toast('Enter a budget greater than zero', 'error'); return; }
  const maxBytes = Math.round(value * unit);
  const target = budgetTarget;
  try {
    const cur = await currentSavedBudgets();
    const merged = [...cur.filter(b => b.path !== target.path), { path: target.path, maxBytes }];
    await saveBudgetList(merged);
    closeModal('budgetModal');
    toast(`Budget set — ${target.name || target.path} ≤ ${formatBytes(maxBytes)}`);
    await loadBudgets();
  } catch (e) { toast('Could not save budget: ' + e.message, 'error'); }
}

async function removeBudget(path) {
  try {
    const cur = await currentSavedBudgets();
    await saveBudgetList(cur.filter(b => b.path !== path));
    closeModal('budgetModal');
    toast('Budget removed');
    await loadBudgets();
  } catch (e) { toast('Could not remove budget: ' + e.message, 'error'); }
}

$('budgetSaveBtn').addEventListener('click', commitBudget);
$('budgetRemoveBtn').addEventListener('click', () => { if (budgetTarget) removeBudget(budgetTarget.path); });

/* ───────────────────── v4 §9.5 — Notes pinned to folders ─────────────────────
 *
 * state.notes maps path → note. The text is the user's own words and is only
 * ever written into the page through textContent or escapeHtml — a folder
 * note that could run script would hand every folder name on disk a second,
 * worse superpower. tests/notes.test.ts pins that structurally.
 */
function noteFor(path) { return state.notes.get(path) || null; }

async function loadNotes() {
  try {
    const data = await api('/api/notes');
    state.notes = new Map((data.notes || []).map((n) => [n.path, n]));
  } catch {
    // No server-side notes is a fine state to boot in; the editor will say
    // so the moment a save fails for a real reason.
    state.notes = new Map();
  }
}

let noteTarget = null;
function openNoteDialog(node) {
  if (!node) return;
  noteTarget = node;
  const existing = noteFor(node.path);
  $('noteFolderName').textContent = node.name || node.path;
  $('noteFolderPath').textContent = node.path;
  // .value is an inert sink — the note text never becomes markup here.
  $('noteText').value = existing ? existing.text : '';
  $('noteSuppress').checked = existing ? !!existing.suppress : true;
  $('noteRemoveBtn').style.display = existing ? '' : 'none';
  $('noteModal').classList.add('open');
  setTimeout(() => $('noteText').focus(), 30);
}

async function commitNote() {
  if (!noteTarget) return;
  const text = $('noteText').value;
  if (!text.trim()) { toast('Write a note first — or Remove note to clear it', 'error'); return; }
  const target = noteTarget;
  try {
    const data = await api('/api/notes', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target.path, text, suppress: $('noteSuppress').checked }),
    });
    state.notes.set(data.note.path, data.note);
    closeModal('noteModal');
    toast(data.note.suppress
      ? `Note saved — suggestions are paused for ${target.name || target.path}`
      : 'Note saved');
    presentView();
  } catch (e) { toast('Could not save the note: ' + e.message, 'error'); }
}

async function removeNote(path) {
  try {
    await api('/api/notes?path=' + encodeURIComponent(path), { method: 'DELETE' });
    for (const [k, n] of state.notes) { if (n.path === path || k === path) state.notes.delete(k); }
    closeModal('noteModal');
    toast('Note removed');
    presentView();
  } catch (e) { toast('Could not remove the note: ' + e.message, 'error'); }
}

$('noteSaveBtn').addEventListener('click', commitNote);
$('noteRemoveBtn').addEventListener('click', () => { if (noteTarget) removeNote(noteTarget.path); });

/* ───────────────────── v4 §9.6 — Ask in plain words ─────────────────────
 *
 * A query BUILDER with a friendlier front door, never a black box: the
 * translation lands in an editable field and nothing runs until the person
 * presses Run on what they can see. nlTranslate therefore never touches
 * /api/query — tests/nlQuery.test.ts pins that structurally.
 */
function nlOpen() {
  const btn = $('tmNlBtn'), pop = $('nlPop');
  // getBoundingClientRect() is in VIEWPORT coordinates, and #nlPop is
  // position:fixed, so this arithmetic is only right while the viewport is
  // still the popover's containing block. That is why the popover's markup
  // sits at the top level of the body (markup/135-nl-popover.html) and not
  // beside this button: .tm-toolbar carries `container-type: inline-size`,
  // whose layout containment would make the TOOLBAR the containing block and
  // land the popover a toolbar's-worth low and left, clipped by its own
  // stacking context. Never move #nlPop back next to what it points at —
  // tests/nlPopContainment.test.ts fails if any ancestor takes the job.
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 396)) + 'px';
  pop.style.top = (r.bottom + 8) + 'px';
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  $('nlInput').focus();
}
function nlClose(opts = {}) {
  const pop = $('nlPop');
  if (pop.hidden) return;
  pop.hidden = true;
  $('nlOut').hidden = true;
  $('nlReason').hidden = true;
  // FX: a close mid-translation must not leave the weaving orb running in a
  // hidden popover. Idempotent, so the finally in nlTranslate is still safe.
  fxOrbHide('nl');
  // FX: nor the listening chip — a popover can be dismissed (Escape, an
  // outside click that lands on nothing focusable) without a blur firing.
  fxOrbHide('nlListen');
  $('nlPending').hidden = true;
  $('tmNlBtn').setAttribute('aria-expanded', 'false');
  // A close that hands off elsewhere (Run → the highlight box; a view
  // unmount) skips the button focus, or the caret would bounce twice and a
  // screen reader would announce a control the user is already past.
  if (opts.focusButton !== false) $('tmNlBtn').focus();
}
async function nlTranslate() {
  const text = $('nlInput').value.trim();
  if (!text) return;
  $('nlReason').hidden = true;
  // FX: while translating the app is working, not listening — the chip
  // yields to the weaving orb for exactly the /api/nl-query round-trip;
  // the finally below and nlClose (a close mid-flight) both drop that.
  fxOrbHide('nlListen');
  $('nlPending').hidden = false;
  fxOrbShow('nl', $('nlPending').querySelector('.fx-orb-well'), 'weaving');
  try {
    const res = await api('/api/nl-query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      $('nlOut').hidden = false;
      // .value is inert; the details line is built with textContent, so the
      // model's words and the user's own can never become markup.
      $('nlResult').value = res.q;
      const bits = [];
      if (res.matched && res.matched.length) bits.push(`understood: ${res.matched.map((m) => m.phrase).join(', ')}`);
      if (res.unmatched && res.unmatched.length) bits.push(`ignored: ${res.unmatched.join(', ')}`);
      $('nlDetail').textContent = bits.join(' · ');
      $('nlResult').focus();
      $('nlResult').select();
    } else {
      $('nlOut').hidden = true;
      $('nlReason').hidden = false;
      $('nlReason').textContent = res.reason || 'That could not be translated.';
    }
  } catch (e) {
    $('nlOut').hidden = true;
    $('nlReason').hidden = false;
    $('nlReason').textContent = 'Translation failed: ' + e.message;
  } finally {
    fxOrbHide('nl');
    $('nlPending').hidden = true;
    // FX: the listening chip returns only if the person is still in the ask
    // field — a failed translate leaves them there to retype; success moved
    // focus to the result, and its blur handler already dropped the chip.
    if (!$('nlPop').hidden && document.activeElement === $('nlInput')) {
      fxOrbShow('nlListen', $('nlListenWell'), 'listening');
    }
  }
}
function nlRunTranslated() {
  // What runs is what the FIELD holds — the person's edits included. It goes
  // through the highlight box's own flow, the same path a typed query takes.
  const q = $('nlResult').value.trim();
  if (!q) return;
  $('tmSearch').value = q;
  $('tmSearch').dispatchEvent(new Event('input', { bubbles: true }));
  nlClose({ focusButton: false });
  $('tmSearch').focus();
}
$('tmNlBtn').addEventListener('click', () => { $('nlPop').hidden ? nlOpen() : nlClose(); });
$('nlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void nlTranslate(); } });
$('nlResult').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nlRunTranslated(); } });
$('nlRun').addEventListener('click', nlRunTranslated);
$('nlCancel').addEventListener('click', nlClose);
$('nlPop').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); nlClose(); } });
document.addEventListener('mousedown', (e) => {
  const pop = $('nlPop');
  if (!pop.hidden && !pop.contains(e.target) && e.target !== $('tmNlBtn') && !$('tmNlBtn').contains(e.target)) nlClose();
});

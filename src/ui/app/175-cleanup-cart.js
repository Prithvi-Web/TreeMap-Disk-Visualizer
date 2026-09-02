/* ───────────────────────────── Cleanup cart (Feature 2) ───────────────────────────── */
state.cart = new Set();
try { JSON.parse(localStorage.getItem('tm-cart') || '[]').forEach((p) => state.cart.add(p)); } catch {}

/**
 * How many cart rows are put in the DOM at once.
 *
 * Measured: rebuilding the list is **44.1 ms for 1,000 rows**, and the list is
 * rebuilt on every cart click — right at §2.5's 50 ms main-thread budget, and
 * past it above about 1,100 items. Staging a 1,000-hit query is one click
 * away, so that is not a hypothetical cart.
 *
 * The same shape Duplicates already uses (`DUP_PAGE`): show a page, say how
 * many are not shown, and offer to render the rest on an explicit click —
 * which then pays the cost once, deliberately, rather than on every toggle.
 * §2.4's rule applies: a cap that is not stated is a lie about the list.
 *
 * Every TOTAL — the tab count, "Reclaims", the goal meter, the commit itself —
 * is computed from the whole Set and is unaffected by what is drawn.
 */
const CART_PAGE = 200;
let cartShown = CART_PAGE;

function saveCart() { localStorage.setItem('tm-cart', JSON.stringify([...state.cart])); }
function cartHas(p) { return state.cart.has(p); }
function cartNode(p) { return nodeFor(p); }
// "Known" means the scan really contains it — not merely that the pruned tree
// we were handed happened to include it. renderCart resolves these first.
function cartKnownPaths() { return [...state.cart].filter((p) => nodeFor(p)); }
function cartTotalBytes() { return [...state.cart].reduce((s, p) => s + (cartNode(p)?.size ?? 0), 0); }
function cartToggle(p) {
  if (!p) return;
  if (state.cart.has(p)) state.cart.delete(p); else state.cart.add(p);
  saveCart(); renderCart(); refreshCartButtons();
  cartPreviewInvalidated();
}
function cartClear() {
  state.cart.clear();
  cartShown = CART_PAGE; // a new list, not the one the user asked to see all of
  saveCart(); renderCart(); refreshCartButtons();
  cartPreviewInvalidated();
}

/**
 * Bulk door on the ONE cart (v4 §9.2's tour stages whole suggestion groups).
 * Same persistence, same render pipeline as cartToggle — run once instead of
 * per item, because cartToggle's per-call render cost 30.5 ms at 1,500 rows
 * and a 200-item group would multiply that into seconds of blocked thread.
 */
function cartAddMany(paths) {
  let added = 0;
  for (const p of paths) {
    if (p && !state.cart.has(p)) { state.cart.add(p); added++; }
  }
  if (!added) return 0;
  saveCart(); renderCart(); refreshCartButtons();
  cartPreviewInvalidated();
  return added;
}

/**
 * The cart changed, so a drawn preview is now a picture of a cart that no
 * longer exists (v4 §4.3).
 *
 * Rebuilt rather than merely dropped: someone adding a second item while
 * looking at the preview means "and this one too", and blanking the map at
 * that moment would read as a bug. Emptying it exits, because a preview of
 * nothing has nothing to show.
 */
function cartPreviewInvalidated() {
  if (!tmPreview.on) return;
  if (!state.cart.size) { exitCartPreview(); return; }
  const saved = tmPreview.saved;
  state.treemap.nodes = saved;      // rebuild from the real layout, never from a preview
  tmPreview.on = false;
  tmPreview.saved = null;
  enterCartPreview();
  // enterCartPreview refuses when nothing staged is on this map; if it did,
  // the real layout is already back in place and the chrome is already off.
}

/**
 * Sync the +/✓ state of every per-row "add to cart" button currently on screen.
 *
 * Buttons already showing the right icon are left completely alone. Rewriting
 * all of them unconditionally cost 30.5 ms of blocked main thread per cart
 * click once a large near-duplicate result had put ~1,500 of them in the DOM —
 * a stutter in every view, from a list the user wasn't even looking at.
 */
function refreshCartButtons(roots = [document]) {
  for (const root of (Array.isArray(roots) ? roots : [roots])) root.querySelectorAll('[data-cart-add]').forEach((b) => {
    const inIt = state.cart.has(b.getAttribute('data-cart-add'));
    const want = inIt ? '1' : '0';
    if (b.dataset.cartin === want) return;
    b.dataset.cartin = want;
    b.classList.toggle('cartin', inIt);
    b.innerHTML = icon(inIt ? 'check' : 'plus', 14);
    b.setAttribute('title', inIt ? 'Remove from cleanup cart' : 'Add to cleanup cart');
  });
  // The duplicates funnel's "staged in cart" stage reads the same set these
  // buttons reflect — every cart mutation passes through here, so this is
  // the one place that keeps the funnel current.
  if (state.view === 'duplicates') updateDupToolbar();
}

/* ── Phase 4 (v4 §4.1) — the goal meter ────────────────────────────────────
   An optional target ("free 50 GB") kept in Settings. The dock fills a bar
   toward it and says, in words, how far along the cart is.

   §4.1 forbids gamification by name — no confetti, no streaks, no badges — so
   the "met" state is one sentence and a colour change, and there is no state
   at all when no target is set. A meter is information; a reward loop aimed at
   deleting your own files would be manipulation.

   Held here rather than read from `settingsData` because that object is only
   populated when the Settings modal is opened, and the meter has to be right
   on the first paint after a reload. */
let cartGoalBytes = null;
/* v4 §9.3 — whether tooltips carry human-scale equivalents. Default on;
   loadCartGoal reads the truth at boot and the Settings save keeps it live. */
let humanScaleOn = true;

/** ONE honesty policy for the live target: boot, every Settings paint (open
    AND save) and the clear button all funnel the server's answer through
    here, so the dock meter can never disagree with the dialog — a freshly
    saved target must never leave the meter on the stale value (QA item 5). */
function adoptCartGoal(bytes) {
  cartGoalBytes = typeof bytes === 'number' && bytes > 0 ? bytes : null;
  renderCartGoal(cartTotalBytes());
  return cartGoalBytes;
}

/** Fetch the target once at boot. A failure leaves the meter hidden, not zero. */
async function loadCartGoal() {
  try {
    const s = await api('/api/settings');
    adoptCartGoal(s.cleanupGoalBytes);
    // §9.3 and §9.2 ride the same boot read: one settings fetch serves all
    // three, and a server that cannot answer starts no tour (better silent
    // than nagging over an error).
    humanScaleOn = s.humanScaleUnits !== false;
    tourMaybeStart(s.tourDone === true);
  } catch {
    adoptCartGoal(null);
  }
}

/**
 * Paint the meter for a staged total.
 *
 * `staged` is passed in rather than recomputed so this stays a pure render of
 * a number the caller already has — renderCart resolves nodes before it knows
 * the total, and reading it twice could show two different figures in the same
 * frame.
 */
function renderCartGoal(staged) {
  const host = $('cartGoal');
  if (!host) return;
  if (!cartGoalBytes) { host.hidden = true; fxGoalPulseSync(null); return; }
  host.hidden = false;
  const pct = Math.min(100, (staged / cartGoalBytes) * 100);
  const met = staged >= cartGoalBytes;
  host.classList.toggle('met', met);
  // FX: one pulse on the crossing — this render funnel owns `met`. Without a
  // scan the staged total is 0 only because cartNode() cannot resolve a size
  // yet, so it says "unknown" rather than seeding the one-shot at "below": a
  // boot restore of an already-met cart is not a crossing the user caused.
  fxGoalPulseSync(state.scanId ? met : null);
  $('cartGoalFill').style.width = pct.toFixed(1) + '%';
  $('cartGoalLine').innerHTML = met
    // Plainly, once. The extra is stated rather than celebrated — it is a fact
    // about the cart, not a prize.
    ? `<b>Target met.</b> <span>${escapeHtml(formatBytes(staged))} staged toward ${escapeHtml(formatBytes(cartGoalBytes))}.</span>`
    : `<span><b>${escapeHtml(formatBytes(staged))}</b> of ${escapeHtml(formatBytes(cartGoalBytes))} staged</span>` +
      `<span class="g-pct num">${Math.round(pct)}%</span>`;
  host.setAttribute('aria-label',
    met
      ? `Cleanup target met: ${formatBytes(staged)} staged toward ${formatBytes(cartGoalBytes)}`
      : `Cleanup target: ${formatBytes(staged)} of ${formatBytes(cartGoalBytes)} staged, ${Math.round(pct)} percent`);
}

async function renderCart() {
  const dock = $('cartDock'); if (!dock) return;
  // The cart persists across sessions and its items may sit in a part of the
  // tree that was pruned away. Resolve them before reading any size, or a real
  // staged file reads as "not in scan" and drops out of the delete.
  await ensureNodes([...state.cart]);
  const n = state.cart.size;
  fxCartPulseSync(n); // FX: one ~2s pulse when the staged count rises
  dock.classList.toggle('show', n > 0);
  if (n === 0) cartDockToggle(false); // an empty cart closes the drawer, and the body class with it
  const total = cartTotalBytes();
  // The cart is one entity across its whole life, so every count and total
  // rolls in place; the plural flip ("item" → "items") is a shape change
  // and snaps by FxNum's own rule.
  countUp($('cartTabCount'), n, String);
  countUp($('cartTabTotal'), total, formatBytes);
  FxNum.rollText($('cartHeadCount'), n + ' item' + (n === 1 ? '' : 's'));
  FxNum.rollHtml($('cartFootTotal'), `Reclaims <b>${formatBytes(total)}</b>`, 'cart');
  renderCartGoal(total);
  const list = $('cartList');
  if (n === 0) {
    list.innerHTML = '<div class="cart-empty">Your cart is empty.<br>Add files from any view to stage them for the Trash.</div>';
    return;
  }
  const all = [...state.cart];
  const drawn = all.slice(0, cartShown);
  list.innerHTML = drawn.map((p) => {
    const node = cartNode(p);
    const name = node ? node.name : (p.split(/[\\/]/).pop() || p);
    return `<div class="cart-item${node ? '' : ' missing'}">
      <div class="meta"><div class="nm" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      <div class="pth" title="${escapeHtml(p)}">${escapeHtml(p)}</div></div>
      <span class="sz num">${node ? formatBytes(node.size) : 'not in scan'}</span>
      <button class="rm" data-cart-rm="${escapeHtml(p)}" aria-label="Remove ${escapeHtml(name)} from cart">${icon('x', 13)}</button>
    </div>`;
  }).join('')
    // Never a silent truncation: the count above and the total below both cover
    // everything, so the list has to say that it does not.
    + (all.length > drawn.length
      ? `<div class="cart-more"><span>${formatCount(all.length - drawn.length)} more staged, not listed here.</span>` +
        `<button class="btn" data-cart-show-all>Show all ${formatCount(all.length)}</button></div>`
      : '');
}

/* ── Phase 4 (v4 §4.4) — committing the cart ──────────────────────────────
   Four things §4.4 requires, in order:

     1. a dry run FIRST, always, showing the exact manifest — every path, its
        bytes, and any refusals with their reasons;
     2. the commit routed through the Time Capsule, so the whole batch is one
        undoable run — and anything too large to protect is left UNDELETED
        rather than deleted unprotected, with the reason in the manifest;
     3. one result summary with a one-click Undo this run;
     4. an Idempotency-Key, so a retried commit cannot double-execute.

   The dry run is not a preference or a checkbox. It is the only path: there is
   no branch in this file that posts `dryRun: false` without first having shown
   what came back from `dryRun: true`. */

/** The run this session last committed, so "Undo" knows what to put back. */
let cartLastRun = null;
/** One key per confirmation, so a retry of the SAME commit cannot run twice. */
let cartCommitKey = '';

async function cartTrashAll() {
  // Resolve first. "Not in the current scan" must mean the scan really lacks
  // it — not that we haven't asked yet. A rescan clears nodeCache, and
  // renderCart's re-resolve is async, so this can be reached unresolved.
  await ensureNodes([...state.cart]);
  const known = cartKnownPaths();
  const missing = state.cart.size - known.length;
  if (!known.length) {
    toast(missing ? 'Staged items aren’t in the current scan — rescan their folder first.' : 'Your cart is empty.', missing ? 'error' : 'success');
    return;
  }

  const btn = $('cartTrash');
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = icon('loader', 14, REDUCED ? '' : 'spin') + 'Checking…';
  let plan;
  try {
    plan = await cartDryRun(known, (done) => {
      btn.innerHTML = icon('loader', 14, REDUCED ? '' : 'spin') + `Checking… ${formatCount(done)}/${formatCount(known.length)}`;
    });
  } catch (e) {
    toast('Could not work out what this would do: ' + e.message, 'error', 8000);
    return;
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }

  const willDelete = (plan.items || []).filter((i) => i.willDelete);
  resetOpenHandleWarning();  // and with it, the button back to "Move to Trash"
  // The shared dialog trashes `confirmPaths` whenever no callback is set, and
  // that array is whatever the LAST dialog left in it. Cleared here so neither
  // branch below can arm the OK button with an unrelated set of files.
  confirmPaths = [];
  $('confirmTitle').innerHTML = icon('trash', 18) + 'Move to Trash?';
  $('confirmText').innerHTML = cartManifestHtml(plan, missing);
  if (!willDelete.length) {
    // Nothing would happen, so the button says so and does nothing — rather
    // than reading "Move to Trash" over a dialog explaining that it cannot.
    $('confirmOk').innerHTML = icon('x', 15) + 'Close';
    onConfirmTrash = () => {};
  } else {
    cartCommitKey = 'cart-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    // The refusals travel with the commit. Only the deletable paths are sent,
    // so the server has nothing to report as skipped — and a summary that said
    // nothing about them would read as "everything went", one dialog after
    // one that said a petabyte was being left behind.
    const willNot = (plan.items || []).filter((i) => !i.willDelete);
    onConfirmTrash = () => cartExecuteCommit(willDelete.map((i) => i.path), willNot);
  }
  $('confirmModal').classList.add('open');
}

/**
 * How many paths one commit request carries (`MAX_CART_PATHS` server-side).
 *
 * A cart can easily exceed it — staging a 1,000-hit query is one click — so
 * both halves of the commit are chunked rather than refused. The first commit
 * request starts a run and every later one carries its `runId`, which is what
 * keeps a chunked commit a single undoable unit.
 */
const CART_COMMIT_CHUNK = 500;

/** The dry run over any number of paths, merged into one manifest. */
async function cartDryRun(paths, onProgress) {
  const merged = { dryRun: true, items: [], bytesWouldFree: 0, bytesSkipped: 0, evicts: [], capsule: null, openHandles: null, batches: 0, carryOver: null };
  for (let i = 0; i < paths.length; i += CART_COMMIT_CHUNK) {
    const chunk = paths.slice(i, i + CART_COMMIT_CHUNK);
    const part = await api('/api/cart/commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // The capsule state the previous batch would have left behind. Without
      // it each batch plans against the capsule as it stands now and promises
      // room the earlier batches would already have used.
      body: JSON.stringify({ paths: chunk, dryRun: true, ...(merged.carryOver ? { carryOver: merged.carryOver } : {}) }),
    });
    merged.carryOver = part.carryOver;
    merged.items.push(...(part.items || []));
    merged.bytesWouldFree += part.bytesWouldFree || 0;
    merged.bytesSkipped += part.bytesSkipped || 0;
    merged.evicts.push(...(part.evicts || []));
    // The capsule's own state is the same answer every time; keep the first.
    if (!merged.capsule) merged.capsule = part.capsule;
    // Open handles: the conflicts accumulate, the caveats come from the first.
    if (!merged.openHandles) merged.openHandles = part.openHandles;
    else if (part.openHandles && part.openHandles.conflicts) {
      merged.openHandles = {
        ...merged.openHandles,
        conflicts: [...(merged.openHandles.conflicts || []), ...part.openHandles.conflicts],
      };
    }
    merged.batches++;
    if (onProgress) onProgress(Math.min(paths.length, i + chunk.length));
  }
  return merged;
}

/**
 * The manifest, as the confirmation dialog shows it.
 *
 * The skipped half is not a footnote: §4.4 says a refusal is shown in the
 * manifest and "never hidden in a log", and an item the capsule cannot protect
 * is an item that will still be on the disk afterwards. Saying that before the
 * click is the difference between a guarantee and a surprise.
 */
function cartManifestHtml(plan, missingFromScan) {
  const items = plan.items || [];
  const going = items.filter((i) => i.willDelete);
  const staying = items.filter((i) => !i.willDelete);
  const rows = staying.slice(0, 6).map((i) =>
    `<div class="cart-mf-row"><span class="nm" title="${escapeHtml(i.path)}">${escapeHtml(baseName(i.path))}</span>` +
    `<span class="why">${escapeHtml(i.reason || 'Could not be protected.')}</span></div>`).join('');

  let html = going.length
    ? `Move <b>${formatCount(going.length)} item${going.length === 1 ? '' : 's'}</b> (${escapeHtml(formatBytes(plan.bytesWouldFree))}) to the Trash?`
    : `<b>Nothing can be moved to the Trash right now.</b>`;

  if (plan.capsule && plan.capsule.available === false) {
    html += `<div class="cart-mf-note">${escapeHtml(plan.capsule.reason || 'The Time Capsule is unavailable.')}</div>`;
  } else if (going.length) {
    html += `<div class="cart-mf-note">Each one is copied into the <b>Time Capsule</b> and checked before anything is deleted, so the whole batch can be undone in one click — even after you empty the Trash.</div>`;
  }
  if (staying.length) {
    html += `<div class="cart-mf-left"><b>${formatCount(staying.length)} will be left in place</b>` +
      (plan.bytesSkipped ? ` (${escapeHtml(formatBytes(plan.bytesSkipped))})` : '') +
      ` — not deleted:</div><div class="cart-mf-list">${rows}` +
      (staying.length > 6 ? `<div class="cart-mf-row muted">…and ${formatCount(staying.length - 6)} more</div>` : '') +
      `</div>`;
  }
  if (plan.evicts && plan.evicts.length) {
    html += `<div class="cart-mf-note">${formatCount(plan.evicts.length)} older Time Capsule ${plan.evicts.length === 1 ? 'copy' : 'copies'} will be dropped to make room, and can no longer be restored from there.</div>`;
  }
  if (plan.batches > 1) {
    // Each batch carries the capsule state the previous one would have left,
    // so the arithmetic is cumulative and this figure is not optimistic. The
    // batch count is still worth saying — it explains the pause — but it is no
    // longer a caveat about accuracy.
    html += `<div class="cart-mf-note">Checked in ${formatCount(plan.batches)} batches, each counting the Time Capsule room the one before it would have used.</div>`;
  }
  const oh = plan.openHandles;
  const conflicts = (oh && oh.conflicts) || [];
  if (conflicts.length) {
    html += `<div class="cart-mf-note">${icon('alert', 13)} ${formatCount(conflicts.length)} of these ${conflicts.length === 1 ? 'is' : 'are'} open in another program right now, which will stop the whole batch.</div>`;
  }
  // openHandleGuard's rule: a guard that cannot check must never answer
  // "nothing is open". The server reports three states and the conflicts list
  // is empty in two of them, so reading only that list turned "could not
  // check" into a dialog with no caveat at all. `reason` is the server's own
  // sentence — the probe knows why it could not answer and this does not.
  if (oh && oh.checked === false) {
    html += `<div class="cart-mf-note">${icon('alert', 13)} ${escapeHtml(oh.reason || 'TreeMap couldn’t check whether these files are in use.')}</div>`;
  } else if (oh && oh.complete === false) {
    html += `<div class="cart-mf-note">${icon('alert', 13)} ${escapeHtml(oh.reason || 'TreeMap could not check every file in this set, so some open files may not be listed.')}</div>`;
  }
  if (missingFromScan) {
    html += `<div class="cart-mf-note">${formatCount(missingFromScan)} item${missingFromScan === 1 ? '' : 's'} not in the current scan will stay in the cart.</div>`;
  }
  return html;
}

/**
 * Protect → verify → Trash, as one run. Idempotency-Key'd (§4.4 step 4).
 *
 * `foreseen` is what the dry run already refused; those paths are never sent,
 * so they stay staged in the cart and are reported alongside anything the
 * server refuses on the day.
 */
async function cartExecuteCommit(paths, foreseen = []) {
  const btn = $('cartTrash');
  const label = btn.innerHTML;
  const result = { dryRun: false, runId: null, trashed: [], bytesFreed: 0, skipped: [], failedToTrash: [] };
  try {
    for (let i = 0; i < paths.length; i += CART_COMMIT_CHUNK) {
      const chunk = paths.slice(i, i + CART_COMMIT_CHUNK);
      if (paths.length > CART_COMMIT_CHUNK) {
        btn.disabled = true;
        btn.innerHTML = icon('loader', 14, REDUCED ? '' : 'spin') +
          `Deleting… ${formatCount(Math.min(paths.length, i))}/${formatCount(paths.length)}`;
      }
      const part = await api('/api/cart/commit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // One key per chunk, derived from the confirmation's key: a retry of
          // the SAME chunk replays, while the next chunk is a new request.
          'Idempotency-Key': `${cartCommitKey}-${i / CART_COMMIT_CHUNK}`,
        },
        // Every chunk after the first joins the run the first one started, so
        // "Undo this run" puts the whole cart back rather than one batch of it.
        body: JSON.stringify({ paths: chunk, dryRun: false, ...(result.runId ? { runId: result.runId } : {}) }),
      });
      if (!result.runId) result.runId = part.runId;
      result.trashed.push(...(part.trashed || []));
      result.bytesFreed += part.bytesFreed || 0;
      result.skipped.push(...(part.skipped || []));
      result.failedToTrash.push(...(part.failedToTrash || []));
      if (part.capsuleUnavailable) result.capsuleUnavailable = part.capsuleUnavailable;
    }
  } catch (e) {
    // Partial: earlier chunks may already have been deleted, and they are
    // recoverable through the run they belong to. Saying "nothing was deleted"
    // when something was is the one message that must not be sent here.
    if (result.trashed.length) {
      (result.trashed || []).forEach((p) => state.cart.delete(p));
      saveCart(); renderCart(); refreshCartButtons();
      cartLastRun = result.runId;
      toast(`Stopped after ${formatCount(result.trashed.length)} item${result.trashed.length === 1 ? '' : 's'}: ${e.message}`, 'error', 12000);
      cartCommitSummary(result);
      rescan();
    } else {
      toast('Nothing was deleted: ' + e.message, 'error', 10000);
    }
    return;
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
  (result.trashed || []).forEach((p) => state.cart.delete(p));
  cartShown = CART_PAGE;
  saveCart();
  renderCart();
  refreshCartButtons();
  cartLastRun = result.trashed && result.trashed.length ? result.runId : null;
  cartCommitSummary({
    ...result,
    skipped: [
      ...(result.skipped || []),
      ...foreseen.map((i) => ({ path: i.path, code: i.code, reason: i.reason })),
    ],
  });
  if (result.trashed && result.trashed.length) rescan();
}

/**
 * One summary for the whole run, with the undo attached (§4.4 step 3).
 *
 * Skipped items are reported as **still on the disk**, because they are. The
 * temptation is to fold them into a count of failures; they are not failures,
 * they are the safety rule doing its job, and the wording says so.
 */
function cartCommitSummary(result) {
  const trashed = result.trashed || [];
  const skipped = result.skipped || [];
  const failed = result.failedToTrash || [];

  let html = trashed.length
    ? `Moved <b>${formatCount(trashed.length)}</b> item${trashed.length === 1 ? '' : 's'} to the Trash — <b>${escapeHtml(formatBytes(result.bytesFreed || 0))}</b> recovered.`
    : `<b>Nothing was deleted.</b>`;
  if (result.capsuleUnavailable) {
    html += `<div class="cart-mf-note">${escapeHtml(result.capsuleUnavailable)}</div>`;
  }
  if (skipped.length) {
    html += `<div class="cart-mf-left"><b>${formatCount(skipped.length)} left in place</b> — still on your disk, not deleted, and still in your cart:</div>` +
      `<div class="cart-mf-list">` + skipped.slice(0, 6).map((sk) =>
        `<div class="cart-mf-row"><span class="nm" title="${escapeHtml(sk.path)}">${escapeHtml(baseName(sk.path))}</span>` +
        `<span class="why">${escapeHtml(sk.reason || 'Could not be protected.')}</span></div>`).join('') +
      (skipped.length > 6 ? `<div class="cart-mf-row muted">…and ${formatCount(skipped.length - 6)} more</div>` : '') +
      `</div>`;
  }
  if (failed.length) {
    html += `<div class="cart-mf-note">${icon('alert', 13)} ${formatCount(failed.length)} could not be moved to the Trash (${escapeHtml(failed[0].reason)}). Those are untouched, and their copies were discarded.</div>`;
  }
  if (trashed.length) {
    // The capsule verifies content byte for byte AND puts the recorded
    // timestamps back, so this is a whole-file restore rather than a copy made
    // today. It was not always: until the dates were recorded, an undo left
    // everything looking modified just now, and an age-based rule stopped
    // matching the very files it had just been used to find.
    html += `<div class="cart-mf-undo"><button class="btn" data-cart-undo="${escapeHtml(result.runId)}">` +
      `${icon('refresh', 14)}Undo this run</button>` +
      `<span class="muted">Puts all ${formatCount(trashed.length)} back where they were, from the Time Capsule — ` +
      `byte for byte, with their original dates.</span></div>`;
  }

  $('confirmTitle').innerHTML = icon('checkCircle', 18) + 'Done';
  $('confirmText').innerHTML = html;
  // A summary is not a question. An explicit no-op, not a null callback: null
  // means "fall back to trashing confirmPaths", which is the last thing a
  // dialog reporting a completed delete should be able to do.
  confirmPaths = [];
  onConfirmTrash = () => {};
  $('confirmOk').innerHTML = icon('check', 15) + 'Close';
  $('confirmModal').classList.add('open');
}

/** Restore a whole committed run from the Time Capsule (§4.4 step 3). */
async function cartUndoRun(runId) {
  let job;
  try {
    job = await api('/api/cart/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'undo-' + runId },
      body: JSON.stringify({ runId }),
    });
  } catch (e) {
    toast('Could not undo: ' + e.message, 'error', 10000);
    return;
  }
  closeModal('confirmModal');
  // Through the same progress dialog every other copy-and-verify job uses —
  // it IS the capsule's restore, not a second one (§10: no new pathway).
  watchJob({
    title: 'Putting everything back…',
    icon: 'clock',
    progressUrl: `/api/timecapsule/jobs/${encodeURIComponent(job.jobId)}/progress`,
    cancelUrl: `/api/timecapsule/jobs/${encodeURIComponent(job.jobId)}/cancel`,
    footNote: 'Every byte is checked against the fingerprint taken when it was protected.',
    cancelledMessage: 'Undo cancelled — nothing was left half-written',
    lostMessage: 'Lost the progress stream — reopen the Time Capsule tab for the result',
    onComplete: () => {
      toast(`Everything from that run is back — ${formatCount(job.entryCount)} item${job.entryCount === 1 ? '' : 's'}`);
      cartLastRun = null;
      rescan();
    },
    onSettled: () => { renderCart(); refreshCartButtons(); },
  });
}

// Drawer + delegated row-button wiring.
/**
 * Open or close the drawer, and mirror that onto `<body>`.
 *
 * The mirror exists because the dock is `position: fixed` and the preview
 * banner is inside the treemap, so CSS in the banner cannot otherwise know the
 * dock is there. One toggle function rather than three inline handlers, so the
 * class and the drawer cannot drift apart.
 */
function cartDockToggle(open, { focus = false } = {}) {
  const dock = $('cartDock');
  const next = open === undefined ? !dock.classList.contains('open') : open;
  const hadFocus = dock.contains(document.activeElement);
  dock.classList.toggle('open', next);
  document.body.classList.toggle('cart-open', next);
  // Keyboard users must land where they can act. A drawer opened from the
  // tab left focus on the tab, with Escape climbing the map instead of
  // closing the drawer; closing from inside it left focus on a hidden button.
  // Pointer users are where their pointer is — a click moves no focus.
  if (next) {
    if (focus) requestAnimationFrame(() => { const c = $('cartCollapse'); if (c && dock.classList.contains('open')) c.focus({ preventScroll: true }); });
  } else if (hadFocus) {
    $('cartTab').focus({ preventScroll: true });
  }
}
$('cartTab').addEventListener('click', () => cartDockToggle());
$('cartTab').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cartDockToggle(undefined, { focus: true }); } });
$('cartCollapse').addEventListener('click', () => cartDockToggle(false));
$('cartClear').addEventListener('click', cartClear);
$('cartTrash').addEventListener('click', cartTrashAll);
document.addEventListener('click', (e) => {
  const add = e.target.closest('[data-cart-add]');
  if (add) { e.preventDefault(); e.stopPropagation(); cartToggle(add.getAttribute('data-cart-add')); return; }
  const rm = e.target.closest('[data-cart-rm]');
  if (rm) { e.preventDefault(); e.stopPropagation(); cartToggle(rm.getAttribute('data-cart-rm')); return; }
  const undo = e.target.closest('[data-cart-undo]');
  if (undo) { e.preventDefault(); e.stopPropagation(); void cartUndoRun(undo.getAttribute('data-cart-undo')); return; }
  // Delegated like every other cart button. A listener bound per render is
  // attached to an element the next render throws away, which is exactly the
  // kind of thing that works until something re-renders between the bind and
  // the click.
  const showAll = e.target.closest('[data-cart-show-all]');
  if (showAll) { e.preventDefault(); e.stopPropagation(); cartShown = Infinity; void renderCart(); }
});
renderCart(); // reflect any persisted cart on load
void loadCartGoal(); // §4.1 — the target, so the meter is right before Settings is ever opened

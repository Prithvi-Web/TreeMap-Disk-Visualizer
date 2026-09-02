/* ═══════════════ FX: living-surface wiring ═══════════════
   Every beam and orb in the app marks a real state, and each one is switched
   by the function that owns that state — never by a poll. The helpers here
   exist for one contract: every FxOrbs.mount has exactly one paired destroy
   (the same rule registerView enforces for timers), even when the surface an
   orb sits on is later rewritten with innerHTML. Handles are keyed by
   surface, so a re-entry retargets in place instead of stacking mounts. */

const fxOrbLive = new Map(); // surface key -> { orb, slot }

/**
 * Mount (or retarget) the keyed 20px/64px orb inside `host`. The orb gets its
 * own slot element so a host whose innerHTML is later rewritten can only ever
 * strand the slot, never an untracked handle — fxOrbHide still finds and
 * destroys the orb (destroy is safe on a detached canvas).
 */
function fxOrbShow(key, host, orbState, opts = {}) {
  const cur = fxOrbLive.get(key);
  if (cur && cur.slot.parentNode === host && cur.slot.isConnected) { cur.orb.setState(orbState); return; }
  fxOrbHide(key);
  if (!host) return;
  const slot = document.createElement('span');
  slot.className = 'fx-orb-slot fx-orb-inline';
  host.appendChild(slot);
  fxOrbLive.set(key, { orb: FxOrbs.mount(slot, { state: orbState, size: opts.size || 20, ariaLabel: opts.ariaLabel }), slot });
}

/** The paired destroy. Idempotent, and safe after the host was rewritten. */
function fxOrbHide(key) {
  const cur = fxOrbLive.get(key);
  if (!cur) return;
  fxOrbLive.delete(key);
  cur.orb.destroy();
  cur.slot.remove();
}

/**
 * The 64px "searching" hero on the active view's empty surface, while a FIRST
 * scan runs. `!state.root` is what keeps this honest: a rescan leaves the old
 * picture up, and a hero over real data would be decoration. At most one hero
 * exists, in the well of whichever view is actually on screen — an orb in a
 * hidden view would keep drawing frames nobody sees.
 * Called from the scan chrome funnel (begin/endScanChrome) and switchView —
 * the two owners of the state it renders.
 */
function fxScanHeroSync() {
  const busy = state.scanning && !state.root;
  const well = !busy ? null
    : state.view === 'treemap' ? $('tmScanOrb')
    : state.view === 'dashboard' ? $('dashScanOrb')
    : null;
  if (well) fxOrbShow('scanHero', well, 'searching', { size: 64 });
  else fxOrbHide('scanHero');
}

/**
 * §2.5's refinement loop, made visible: the "shaping" chip is up exactly while
 * a circles/Voronoi layout still has queued subdivision slices. On/off comes
 * from buildCells and altRefineSchedule (the owners of `done`), and
 * altRefineCancel — every one of that loop's exit doors, the view's unmount
 * included — drops it.
 */
function fxShapeSync(refining) {
  if (refining) fxOrbShow('shape', $('tmShapeOrb'), 'shaping');
  else fxOrbHide('shape');
}

/** The one glow in the zero state: the primary CTA, only while the welcome
    screen is what the user is looking at. */
function fxEmptyCtaSync(showing) {
  FxBeam.attach($('emptyBrowseBtn'), { type: 'pulse-outside', active: showing });
}

/**
 * The Autopilot heartbeat: the 20px "breathing" orb sits in the policies
 * card header exactly while at least one policy is armed to act on its own
 * — enabled, approved, past preview. renderAutopilot (the single render
 * funnel, which already computes that set) is the on/off switch; the load
 * error path and the view's unmount are the other exit doors. Runs carry no
 * client-visible "executing" status (awaiting-approval / completed /
 * blocked / failed are the whole union), so armed-and-idle is the whole
 * truth this orb can honestly tell.
 */
function fxApBreatheSync(armed) {
  if (armed) fxOrbShow('apBreathe', $('apBreatheWell'), 'breathing', { ariaLabel: 'Autopilot is armed and watching' });
  else fxOrbHide('apBreathe');
}

/**
 * The donut card's bklit loading veil: on exactly while the type breakdown
 * is pending (scan chrome, the index-first pending window, a mid-scan
 * dashboard re-entry), off in renderDonut and restoreDashboardPanels — the
 * only painters of that card. The veil is CSS, so it needs no destroy pair
 * beyond this off switch.
 */
function fxDonutLoadingSync(on) {
  const wrap = document.querySelector('.donut-canvas-wrap');
  if (wrap) wrap.classList.toggle('fx-chart-loading', !!on);
}

/* One-shot pulse on the cart tab when the staged count RISES. renderCart is
   the single render funnel for cart state, so it is the one caller. Seeded at
   -1: the boot restore of a persisted cart is not an increase the user just
   caused, and must not glow. */
let fxCartSeen = -1;
let fxCartPulseTimer = 0;
function fxCartPulseSync(count) {
  if (fxCartSeen >= 0 && count > fxCartSeen) {
    FxBeam.attach($('cartTabBeamStrip'), { type: 'pulse-inner', active: true });
    clearTimeout(fxCartPulseTimer);
    fxCartPulseTimer = setTimeout(() => FxBeam.attach($('cartTabBeamStrip'), { type: 'pulse-inner', active: false }), 2000);
  }
  fxCartSeen = count;
}

/* The "line" beam on both search fields, lit only while focused. It attaches
   to the overlay strip, never the wrap — see the styles block for why. */
for (const [inputId, stripId] of [['gsearch', 'gsearchBeamStrip'], ['tmSearch', 'tmSearchBeamStrip']]) {
  $(inputId).addEventListener('focus', () => FxBeam.attach($(stripId), { type: 'line', active: true }));
  $(inputId).addEventListener('blur', () => FxBeam.attach($(stripId), { type: 'line', active: false }));
}

/* The 20px "listening" chip beside the plain-words box: on exactly while
   the field is focused and awaiting typing. The translate round-trip swaps
   it for the weaving orb (nlTranslate owns that edge), and nlClose is the
   backstop for a popover dismissed without a blur ever firing. */
$('nlInput').addEventListener('focus', () => fxOrbShow('nlListen', $('nlListenWell'), 'listening'));
$('nlInput').addEventListener('blur', () => fxOrbHide('nlListen'));

/* ── State-owned beams ────────────────────────────────────────────────────
   A real state (a running scan, a duplicate hunt, a compare) lights its
   card at full brightness through fxStateBeam, which stamps
   data-fxbeam-state while active so the CSS lens rules and any later
   reader can tell an owned host from an idle one. Hover ambience used to
   share these cards and needed a takeover door here; it is gone, so the
   stamp is the whole contract. FxBeam keys instances by element: a state
   beam holds its card exclusively for as long as it is lit. */
function fxStateBeam(el, opts) {
  if (!el) return;
  if (opts.active) {
    el.setAttribute('data-fxbeam-state', '');
  } else {
    el.removeAttribute('data-fxbeam-state');
  }
  FxBeam.attach(el, opts);
}

/** The teardown for a state beam on an innerHTML-transient host: a card the
    next rewrite destroys must never strand its instance (style tag +
    registry entry), so the off-path detaches instead of fading. */
function fxStateBeamDrop(el) {
  if (!el) return;
  el.removeAttribute('data-fxbeam-state');
  FxBeam.detach(el);
}

/* ── Hover ambience on glass cards: REMOVED (owner's call, 2 Sep 2026) ───
   A quiet md ring used to light the card under the pointer: a CSS animation
   on a registered custom property driving two masked conic gradients with
   filters, recomputing style every frame for the whole hover plus a 0.5s
   fade — one card at a time, but that card was always the one being read.
   The owner asked for "blazing fast in all areas", so hover now costs
   nothing: the .card.glass:hover lift in CSS is the whole affordance, and
   state beams (a running scan, a hunt) keep the envelope to themselves. */

/* ── Persistent mode pills — the sm ring on settings that are ON ─────────
   A mode pill that stays on is a live state, not a moment: Live while
   watching, Lens while pinned, Loop and Diff while enabled, Hide-cloud
   while on. One sync reads all five state variables, and every funnel that
   flips one (enableLive/disableLive, lensSetPinned, lapseReflect, the Diff
   and Hide-cloud toggles, the no-cloud-files reset) calls it; the treemap's
   mount re-lights and its unmount (visible=false — state.view still says
   'treemap' during unmount, so the caller must say so) is the shared off
   door. attach is idempotent and keyed, so re-syncing is cheap. */
function fxTmPillBeamsSync(visible = state.view === 'treemap') {
  const pill = (id, on) => { const el = $(id); if (el) FxBeam.attach(el, { type: 'sm', active: !!on && visible, strength: 0.7 }); };
  pill('tmLiveToggle', state.live.on);
  pill('tmLensToggle', state.lens.pinned);
  pill('tmLapseLoop', state.treemap.lapse.loop);
  pill('tmDiffToggle', state.treemap.history.diff);
  pill('tmCloudToggle', state.treemap.hideCloud);
}

/* ── The hunt beams: md on a progress card, gone with the card ───────────
   The exact-duplicates hunt and the Compare diff both paint a transient
   `.dup-progress` card and settle by rewriting their host's innerHTML, so
   the beam rides exactly the doors the 'dup' orb documents: on with the
   card, DROPPED (detached) on settle, error, re-entry and the view's
   unmount. No card in the host means nothing to do — the off calls are
   safe on every path. */
function fxHuntBeamSync(hostId, on) {
  const host = $(hostId);
  const card = host && host.querySelector('.dup-progress');
  if (!card) return;
  if (on) fxStateBeam(card, { type: 'md', active: true });
  else fxStateBeamDrop(card);
}

/* ── One-shot: the goal meter's crossing ─────────────────────────────────
   One ~2s pulse the moment the staged total first crosses the cleanup
   target — the cart pulse's voice (a state-change notice), not a §4.1
   reward loop: it cannot repeat while the cart stays over target, and the
   met state itself remains renderCartGoal's sentence and colour. Seeded
   null: a boot restore that is already over target is not a crossing the
   user just caused, and a hidden meter (no target set) resets the seed. */
let fxGoalMetSeen = null;
let fxGoalPulseTimer = 0;
function fxGoalPulseSync(met) {
  if (met === null) { fxGoalMetSeen = null; return; }
  met = !!met;
  if (fxGoalMetSeen === false && met) {
    FxBeam.attach($('cartGoal'), { type: 'pulse-outside', active: true, strength: 0.55, borderRadius: 10 });
    clearTimeout(fxGoalPulseTimer);
    fxGoalPulseTimer = setTimeout(() => FxBeam.attach($('cartGoal'), { type: 'pulse-outside', active: false }), 2200);
  }
  fxGoalMetSeen = met;
}

/* ── One-shot: scan completion ───────────────────────────────────────────
   A subtle outward pulse on the scan card when a scan actually completes.
   finishScan calls this behind its own `state.scanId` gate — the same gate
   as the completion toast — so the index-first instant paint (finishScan's
   first pass) and failScan never pulse. The off-timer defers to a scan
   that started inside the 2s window: beginScanChrome's md ring owns the
   card then, and endScanChrome is its off door. */
let fxScanDoneTimer = 0;
function fxScanDonePulse() {
  const card = $('scanStatus').closest('.card');
  if (!card) return;
  fxStateBeam(card, { type: 'pulse-outside', active: true, strength: 0.5 });
  clearTimeout(fxScanDoneTimer);
  fxScanDoneTimer = setTimeout(() => {
    if (!state.scanning) fxStateBeam(card, { type: 'pulse-outside', active: false });
  }, 2000);
}

/* ── Entrance choreography ───────────────────────────────────────────────
   On a genuine view entry (hidden → shown — switchView decides, so a data
   refresh that re-calls it in place never replays this) the view's glass
   cards rise 12px and fade in on a 36ms stagger. Only the first six: cards
   past the fold arrive instantly, because choreographing what nobody can
   see is pure cost — and only cards actually rendered (a card inside a
   hidden pane has no offsetParent and must not consume a stagger slot).
   One-shot WAAPI rather than a class: no residue for an innerHTML rebuild
   to replay, nothing to destroy — a finite animation releases itself, and
   on an unmounted (display: none) view it simply never paints. fill
   'backwards' holds each card transparent through its delay, so the
   stagger reads as arrival instead of a flash of the settled card. */
const FX_ENTER_STAGGERED = 6;
const FX_ENTER_STEP_MS = 36;
function fxViewEnter(viewEl) {
  if (REDUCED || !viewEl || !viewEl.querySelectorAll) return;
  /* Read pass, then write pass. offsetParent forces style+layout, and a
     fill:'backwards' animation applies its first keyframe the moment it is
     created — so interleaving them made every card after the first pay a
     fresh flush over a tree view.mount() had just rewritten. */
  const staged = [];
  for (const card of viewEl.querySelectorAll('.card.glass')) {
    if (!card.offsetParent) continue; // display:none subtree — not on screen
    staged.push(card);
    if (staged.length >= FX_ENTER_STAGGERED) break;
  }
  for (let slot = 0; slot < staged.length; slot++) {
    const card = staged[slot];
    if (typeof card.animate !== 'function') return;
    card.animate(
      [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
      { duration: 380, delay: slot * FX_ENTER_STEP_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' },
    );
  }
}
/* ═══ end FX: living-surface wiring ═══ */

/** Kept as a free function: it is called from the treemap's hot draw loop. */
function roundRect(ctx, x, y, w, h, r) {
  Canvas2D.roundRect(ctx, x, y, w, h, r);
}

/** Blit the buffers (base + search overlay), then the hover highlight. */
function presentTreemap() {
  const dpr = window.devicePixelRatio || 1;
  tmCtx.setTransform(1, 0, 0, 1, 0, 0);
  tmCtx.clearRect(0, 0, tmCanvas.width, tmCanvas.height);
  tmCtx.drawImage(tmBuffer, 0, 0);
  if (state.treemap.query.trim()) tmCtx.drawImage(tmSearchBuffer, 0, 0);
  const h = state.treemap.hover;
  if (h) {
    tmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tmCtx.fillStyle = 'rgba(255,255,255,0.10)';
    tmCtx.fillRect(h.x, h.y, h.w, h.h);
    tmCtx.strokeStyle = cssVar('--accent') || '#0A84FF';
    tmCtx.lineWidth = 2;
    tmCtx.strokeRect(h.x + 1, h.y + 1, h.w - 2, h.h - 2);
  }
  // Over-budget folders get a red dashed border (Feature 15).
  const over = state.budgets.overPaths;
  if (over && over.size) {
    tmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tmCtx.setLineDash([5, 3]);
    tmCtx.strokeStyle = cssVar('--danger') || '#FF453A';
    tmCtx.lineWidth = 2;
    for (const pr of state.treemap.pxRects) {
      if (over.has(pr.n.path)) {
        tmCtx.strokeRect(pr.x + 1.5, pr.y + 1.5, Math.max(1, pr.w - 3), Math.max(1, pr.h - 3));
      }
    }
    tmCtx.setLineDash([]);
  }
  // v4 §9.5 — noted folders carry a small sticky-note glyph in the corner, so
  // "why is nothing here ever suggested?" has a visible answer on the map.
  // Skipped below 26×18 px: at that size the glyph would BE the tile.
  if (state.notes.size) {
    tmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const pr of state.treemap.pxRects) {
      if (!state.notes.has(pr.n.path) || pr.w < 26 || pr.h < 18) continue;
      const s = 9, x0 = pr.x + pr.w - s - 4, y0 = pr.y + 4;
      tmCtx.beginPath();
      tmCtx.moveTo(x0, y0);
      tmCtx.lineTo(x0 + s, y0);
      tmCtx.lineTo(x0 + s, y0 + s - 3);
      tmCtx.lineTo(x0 + s - 3, y0 + s);
      tmCtx.lineTo(x0, y0 + s);
      tmCtx.closePath();
      tmCtx.fillStyle = cssVar('--warn') || '#FFD60A';
      tmCtx.fill();
      tmCtx.strokeStyle = 'rgba(0,0,0,0.45)';
      tmCtx.lineWidth = 1;
      tmCtx.stroke();
    }
  }
  const ks = state.treemap.kbSel;
  if (ks) {
    const pr = state.treemap.pxRects.find((p) => p.n.path === ks.path);
    if (pr) {
      tmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tmCtx.setLineDash([6, 3]); tmCtx.strokeStyle = '#fff'; tmCtx.lineWidth = 2;
      tmCtx.strokeRect(pr.x + 1.5, pr.y + 1.5, Math.max(1, pr.w - 3), Math.max(1, pr.h - 3));
      tmCtx.setLineDash([]);
    }
  }
  drawLivePulses();
  /* Set the transform before the overlays, do not inherit it.

     Everything above this line sets `dpr` INSIDE its own `if` — a hover ring,
     a budget border, a keyboard cursor — and each is optional. With none of
     them showing, the transform is still the identity set at the top of this
     function, and §6.4's lens and §6.3's lasso then draw in device pixels
     while being handed CSS dimensions: half the size, at half the position.

     It looked fine in every hand test, because a hand on a trackpad is
     hovering a cell, which sets the transform on the way past. It shows up the
     moment the pointer is over a gap, or the Lens is pinned and the pointer
     leaves the map. This is the same trap `cityHit` documents — the bug IS the
     device pixel ratio — one function over. */
  tmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lensPaint(tmCtx, tmCanvas.width / dpr, tmCanvas.height / dpr);
  lassoPaint(tmCtx);
}

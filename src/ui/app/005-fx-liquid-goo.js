/* ═══════════════ FX: Liquid Goo ═══════════════ */
/* Vanilla port of the ESSENCE of liquid-gooey (MIT): a two-layer liquid
   sliding thumb for segmented controls, plus a liquid-rubber trail for range
   sliders. The blurred+contrasted SILHOUETTE layer (SVG goo filter — never a
   CSS url() filter on HTML, the one variant WebKit renders right) carries the
   goo, the droplet tail and the rebuilt shadow; the crisp thumb rides above,
   unfiltered. Springs are integrated on the wall clock with capped substeps;
   the loop sleeps entirely once settled (zero idle cost) and is woken by a
   MutationObserver / ResizeObserver, exactly like the library's engine. */
const FxGoo = (() => {
  /* ── Spring core (faithful port of liquid-gooey src/spring.ts) ── */
  const presets = {
    snappy: { stiffness: 480, damping: 34, mass: 1 },
    smooth: { stiffness: 190, damping: 26, mass: 1 },
    bouncy: { stiffness: 320, damping: 17, mass: 1 },
  };
  /* Tuned for the seg thumb: settles in ~342ms with a 0.4% overshoot —
     snappy and physical without wobble (measured via simulate()). */
  const SEG_SPRING = { stiffness: 640, damping: 42, mass: 1 };
  /* observer.ts MOVE_DEFAULTS — the Move effect's tuned look. */
  const MOVE = { stiffness: 380, damping: 18, stretch: 0.18, tail: 0.46, force: 0.5 };
  const SIM_DT = 1 / 240;

  /* Damping ratio from a 0..1 bounciness knob (LiquidItem.tsx zeta): 0.5
     lands on the tuned defaults' ratio, 0 is critically damped, 1 very
     springy. */
  const zeta = (b) => Math.max(0.12, 1 - 1.1 * Math.min(1, Math.max(0, b)));

  /* MoveTuning → raw spring values (LiquidItem.tsx mapMove, curve verbatim):
     stiffness rides the exponential feel curve 380·10^(p−0.5) and damping
     rescales with √stiffness × ζ(wobble)/ζ(0.5), so the default knob
     positions (springiness 0.5, wobble 0.5, stretch 0.36, trail 0.575)
     reproduce MOVE exactly and `speed` changes tempo without changing
     character. `advanced` passes raw values straight through. */
  function mapMove(t) {
    const c01 = (v, d) => Math.min(1, Math.max(0, v == null ? d : v));
    const p = c01(t && t.springiness, 0.5);
    const stiffness = MOVE.stiffness * Math.pow(10, p - 0.5);
    const damping = MOVE.damping * Math.sqrt(stiffness / MOVE.stiffness) *
      (zeta(c01(t && t.wobble, 0.5)) / zeta(0.5));
    return {
      stiffness, damping,
      stretch: 0.5 * c01(t && t.stretch, 0.36),
      tail: 0.8 * c01(t && t.trail, 0.575),
      force: c01(t && t.force, MOVE.force),
      ...((t && t.advanced) || {}),
    };
  }

  function resolveSpring(cfg) {
    if (typeof cfg === 'string') return presets[cfg] || presets.smooth;
    return { stiffness: 300, damping: 24, mass: 1, ...(cfg || {}) };
  }

  /* Normalized 0→1 step response: duration (s), sample list, peak. The same
     simulation the library compiles into CSS linear() easings. */
  function simulate(cfg) {
    const c = resolveSpring(cfg);
    let x = 0, v = 0, t = 0, settledAt = -1, max = 0;
    const xs = [0];
    while (t < 10) {
      const a = (-c.stiffness * (x - 1) - c.damping * v) / c.mass;
      v += a * SIM_DT; x += v * SIM_DT; t += SIM_DT;
      xs.push(x);
      if (x > max) max = x;
      if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.02) {
        if (settledAt < 0) settledAt = t;
        if (t - settledAt >= 0.064) break;
      } else settledAt = -1;
    }
    const duration = settledAt > 0 ? settledAt : t;
    const n = Math.round(Math.min(120, Math.max(24, duration * 90)));
    const lastIdx = Math.min(xs.length - 1, duration / SIM_DT);
    const values = [];
    for (let i = 0; i <= n; i++) {
      const idx = Math.min(xs.length - 1, Math.round((i / n) * lastIdx));
      values.push(Math.round(xs[idx] * 1e4) / 1e4);
    }
    values[values.length - 1] = 1;
    return { duration, values, peak: max, overshoots: max > 1.001 };
  }

  let linearOK = null;
  function supportsLinear() {
    if (linearOK == null) {
      linearOK = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' &&
        CSS.supports('transition-timing-function', 'linear(0, 1)');
    }
    return linearOK;
  }
  const linCache = new Map();
  /* Spring → { duration ms, easing } for CSS transitions (the fallback thumb
     rides this so even degraded motion keeps the spring's character). */
  function compileLinear(cfg) {
    const c = resolveSpring(cfg);
    const key = c.stiffness + '/' + c.damping + '/' + c.mass + '/' + supportsLinear();
    let out = linCache.get(key);
    if (!out) {
      const sim = simulate(c);
      out = {
        duration: Math.round(sim.duration * 1000),
        easing: supportsLinear() ? 'linear(' + sim.values.join(', ') + ')'
          : sim.overshoots ? 'cubic-bezier(0.34, 1.56, 0.64, 1)' : 'cubic-bezier(0.22, 1, 0.36, 1)',
      };
      linCache.set(key, out);
    }
    return out;
  }

  /* Wall-clock spring advance — time follows the wall clock, only the
     integration STEP is capped (observer.ts springSteps, verbatim reasoning).
     Substepped at ≤1/240s, the SAME rate simulate() samples: at 1/60 the
     discrete integrator over-damps a stiff spring and silently eats the
     slight overshoot the whole feel depends on. */
  function springStep(p, v, target, k, c, m, h) {
    const a = (k * (target - p) - c * v) / m;
    const nv = v + a * h;
    return [p + nv * h, nv];
  }
  function springSteps(p, v, target, k, c, m, dt) {
    let n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    while (n-- > 0) { const s = springStep(p, v, target, k, c, m, h); p = s[0]; v = s[1]; }
    return [p, v];
  }

  /* Generic driver: spring(from, to, cfg, onFrame) → handle. onFrame(value,
     done). Under REDUCED it snaps: one onFrame(to, true), no rAF ever. */
  function spring(from, to, cfg, onFrame) {
    const c = resolveSpring(cfg);
    const h = { value: from, target: to, done: false, stop, retarget };
    if (REDUCED) { h.value = to; h.done = true; onFrame(to, true); return h; }
    let v = 0, raf = 0, last = performance.now();
    function tick(now) {
      raf = 0;
      const dt = Math.min(0.25, Math.max(0.0001, (now - last) / 1000));
      last = now;
      [h.value, v] = springSteps(h.value, v, h.target, c.stiffness, c.damping, c.mass, dt);
      const span = Math.max(1, Math.abs(h.target - from));
      if (Math.abs(h.value - h.target) < span * 0.001 + 0.01 && Math.abs(v) < 0.5) {
        h.value = h.target; h.done = true; onFrame(h.value, true);
      } else { onFrame(h.value, false); raf = requestAnimationFrame(tick); }
    }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; h.done = true; }
    function retarget(t) { h.target = t; h.done = false; if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } }
    raf = requestAnimationFrame(tick);
    return h;
  }

  /* ── Silhouette layer: SVG goo filter (numbers from src/filter.tsx) ── */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let uid = 0;
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }
  /* Quantize so near-identical frames make IDENTICAL strings and dirty-checks
     skip the DOM write (WebKit re-rasterizes the filter region on ANY
     primitive-attribute write). Integer divide, so 127 prints as "127" and
     never as float dust. */
  const q = (v, step) => { const d = Math.round(1 / step); return Math.round(v * d) / d; };
  /* Alpha-binarize before band passes — the goo alpha has a soft fringe that
     would read as a second hairline (filter.tsx BINARIZE). */
  const BINARIZE = '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 60 -29.5';

  /* blur 5 / contrast 18 / intercept -7 — the classic goo pairing, scaled for
     control-sized blobs; the intercept tracks the slope (filter.tsx) so a
     detach pair's 8/22 chain thresholds at the same alpha crossing. `deluxe`
     adds the inset ring + top shine rebuilt on the MERGED silhouette (the
     outer --shadow-1 rides as a GPU drop-shadow on the svg element itself,
     via .fxgoo-sil in section.css). `wavy` splices the library's waviness
     pass (feTurbulence 0.018 / 2 octaves / seed 7 → feDisplacementMap,
     scale = waviness·2) between the goo and everything downstream, parked
     at scale 0: a resting control writes no attributes, so the filter is
     never re-rasterized and waviness costs nothing at idle. */
  function buildSilhouette(fill, deluxe, opts) {
    const blur = (opts && opts.blur) || 5;
    const contrast = (opts && opts.contrast) || 18;
    const wavy = !!(opts && opts.wavy);
    const intercept = Math.round((0.5 - contrast * (5 / 12)) * 100) / 100;
    const id = 'fxgoo-f' + (++uid);
    const svg = svgEl('svg', { class: 'fxgoo-sil', 'aria-hidden': 'true', focusable: 'false' });
    const filter = svgEl('filter', {
      id, x: '-60%', y: '-60%', width: '220%', height: '220%',
      'color-interpolation-filters': 'sRGB',
    });
    filter.appendChild(svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: String(blur), result: 'blur' }));
    filter.appendChild(svgEl('feColorMatrix', { in: 'blur', type: 'matrix',
      values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ' + contrast + ' ' + intercept, result: 'goo' }));
    filter.appendChild(svgEl('feComposite', { in: 'SourceGraphic', in2: 'goo', operator: 'atop',
      result: wavy ? 'shape-raw' : 'shape' }));
    let wave = null;
    if (wavy) {
      filter.appendChild(svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.018',
        numOctaves: '2', seed: '7', result: 'wave-noise' }));
      wave = svgEl('feDisplacementMap', { in: 'shape-raw', in2: 'wave-noise', scale: '0',
        xChannelSelector: 'R', yChannelSelector: 'G', result: 'shape' });
      filter.appendChild(wave);
    }
    if (deluxe) {
      filter.appendChild(svgEl('feColorMatrix', { in: 'shape', type: 'matrix', values: BINARIZE, result: 'bin' }));
      /* inset 0 0 0 0.5px ring: erode → out-band → flood → in. */
      filter.appendChild(svgEl('feMorphology', { in: 'bin', operator: 'erode', radius: '0.75', result: 'er' }));
      filter.appendChild(svgEl('feComposite', { in: 'bin', in2: 'er', operator: 'out', result: 'ringBand' }));
      const ringFlood = svgEl('feFlood', { result: 'ringC' });
      ringFlood.style.floodColor = 'var(--hairline, rgba(255,255,255,0.10))';
      filter.appendChild(ringFlood);
      filter.appendChild(svgEl('feComposite', { in: 'ringC', in2: 'ringBand', operator: 'in', result: 'ring' }));
      /* inset 0 1px 0 shine: offset down → out-band along the top edge. */
      filter.appendChild(svgEl('feOffset', { in: 'bin', dx: '0', dy: '1.25', result: 'off' }));
      filter.appendChild(svgEl('feComposite', { in: 'bin', in2: 'off', operator: 'out', result: 'shineBand' }));
      const shineFlood = svgEl('feFlood', { result: 'shineC' });
      shineFlood.style.floodColor = 'var(--shine, rgba(255,255,255,0.11))';
      filter.appendChild(shineFlood);
      filter.appendChild(svgEl('feComposite', { in: 'shineC', in2: 'shineBand', operator: 'in', result: 'shine' }));
      const merge = svgEl('feMerge', {});
      merge.appendChild(svgEl('feMergeNode', { in: 'shape' }));
      merge.appendChild(svgEl('feMergeNode', { in: 'ring' }));
      merge.appendChild(svgEl('feMergeNode', { in: 'shine' }));
      filter.appendChild(merge);
    }
    const defs = svgEl('defs', {});
    defs.appendChild(filter);
    svg.appendChild(defs);
    const group = svgEl('g', { filter: 'url(#' + id + ')' });
    group.style.fill = fill;
    /* Droplet chain (observer.ts): tail + two tapering mid-droplets between
       body and tail keep the merged tongue reading as one organic strand. */
    const tail = svgEl('circle', { cx: '0', cy: '0', r: '0' });
    const midA = svgEl('circle', { cx: '0', cy: '0', r: '0' });
    const midB = svgEl('circle', { cx: '0', cy: '0', r: '0' });
    const body = svgEl('rect', { x: '0', y: '0', width: '0', height: '0', rx: '8' });
    group.appendChild(tail); group.appendChild(midA); group.appendChild(midB); group.appendChild(body);
    svg.appendChild(group);
    return { svg, group, body, tail, midA, midB, wave };
  }

  /* CSS cubic-bezier(x1,y1,x2,y2) sampled the way the style engine samples
     it: solve the x-polynomial for the given progress (Newton with a
     bisection net), return y. y outside [0,1] is legal — that IS the
     overshoot a y1 > 1 curve exists for. */
  function bezierEase(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const xAt = (t) => ((ax * t + bx) * t + cx) * t;
    const dxAt = (t) => (3 * ax * t + 2 * bx) * t + cx;
    const yAt = (t) => ((ay * t + by) * t + cy) * t;
    return (u) => {
      if (u <= 0) return 0;
      if (u >= 1) return 1;
      let t = u;
      for (let i = 0; i < 8; i++) {
        const d = dxAt(t);
        if (Math.abs(d) < 1e-6) break;
        const e = xAt(t) - u;
        if (Math.abs(e) < 1e-6) return yAt(t);
        t -= e / d;
        if (t <= 0 || t >= 1) break;
      }
      let lo = 0, hi = 1;
      t = u;
      for (let i = 0; i < 32; i++) {
        const e = xAt(t) - u;
        if (Math.abs(e) < 1e-6) break;
        if (e < 0) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return yAt(t);
    };
  }

  /* 1-D port of the Move effect's trailing droplet (observer.ts): the tail
     chases the body on a laggier spring (170/22), its lag clamped past the
     trailing edge by `force`, its size a `tail` fraction of the perpendicular
     extent with a short onset ramp; mid-droplets weave an S-curve on a phase
     that rides distance travelled, so it freezes when the drag pauses. */
  function stepTail(st, cx, cy, speed, w, h, dt) {
    const mv = st.mv;
    if (st.tailR === 0 && st.tailX === 0) { st.tailX = cx; st.tailVx = 0; }
    [st.tailX, st.tailVx] = springSteps(st.tailX, st.tailVx, cx, 170, 22, 1, dt);
    const base = Math.max(4, h) / 2;
    const lag = st.tailX - cx;
    const maxLag = w / 2 + base * (0.2 + mv.force * 1.6);
    if (Math.abs(lag) > maxLag) st.tailX = cx + Math.sign(lag) * maxLag;
    const onset = Math.max(0, Math.min(1, (speed - 20) / 120));
    const targetR = base * mv.tail * onset;
    st.tailR += (targetR - st.tailR) * Math.min(1, dt * 10);
    if (st.tailR < 0.3) {
      if (st.lastTail !== 'hidden') {
        st.parts.tail.setAttribute('r', '0');
        st.parts.midA.setAttribute('r', '0');
        st.parts.midB.setAttribute('r', '0');
        st.lastTail = 'hidden';
      }
      return;
    }
    st.tailPhase += speed * dt * 0.045;
    const wob = st.tailR * 0.16;
    const lx = st.tailX - cx;
    const aX = cx + lx * 0.45, aY = cy + Math.sin(st.tailPhase) * wob;
    const bX = cx + lx * 0.75, bY = cy - Math.sin(st.tailPhase + 2.4) * wob;
    const key = q(st.tailX, 0.1) + ',' + q(st.tailR, 0.1) + ',' + q(aX, 0.1) + ',' + q(bX, 0.1) + ',' + q(aY, 0.1);
    if (key !== st.lastTail) {
      st.parts.tail.setAttribute('cx', String(q(st.tailX, 0.1)));
      st.parts.tail.setAttribute('cy', String(q(cy, 0.1)));
      st.parts.tail.setAttribute('r', String(q(st.tailR, 0.1)));
      st.parts.midA.setAttribute('cx', String(q(aX, 0.1)));
      st.parts.midA.setAttribute('cy', String(q(aY, 0.1)));
      st.parts.midA.setAttribute('r', String(q(st.tailR * 0.62, 0.1)));
      st.parts.midB.setAttribute('cx', String(q(bX, 0.1)));
      st.parts.midB.setAttribute('cy', String(q(bY, 0.1)));
      st.parts.midB.setAttribute('r', String(q(st.tailR * 0.4, 0.1)));
      st.lastTail = key;
    }
  }

  /* Waviness rides motion only (the upstream tuning applied ~4): the
     boundary undulates while the liquid is actually travelling — the same
     onset ramp as the tail, so micro-jitters never wake it — and settles
     glass-still. Scale writes are quantized, so an idle control never
     invalidates the filter region. Returns true once fully calm. */
  function stepWave(st, speed, dt) {
    if (!st.sil || !st.sil.wave) return true;
    const target = 4 * Math.max(0, Math.min(1, (speed - 20) / 120));
    st.wave += (target - st.wave) * Math.min(1, dt * 8);
    if (target === 0 && st.wave < 0.12) st.wave = 0;
    const scale = q(st.wave * 2, 0.5);
    if (scale !== st.lastWave) {
      st.sil.wave.setAttribute('scale', String(scale));
      st.lastWave = scale;
    }
    return st.wave === 0;
  }

  /* ── Shared control registry + sleep-when-idle loop ── */
  const states = new Map();

  function wakeLoop(st) {
    if (st.raf || st.dead) return;
    st.last = performance.now();
    st.raf = requestAnimationFrame(function tick(now) {
      st.raf = 0;
      if (st.dead) return;
      const dt = Math.min(0.25, Math.max(0.0001, (now - st.last) / 1000));
      st.last = now;
      let live = false;
      try { live = st.frame(dt); }
      catch (err) { (st.onFail || degrade)(st, err); return; }
      if (live) st.raf = requestAnimationFrame(tick);
    });
  }

  /* Anything throws → tear the goo down to a plain CSS-transition thumb.
     The control must never look broken. */
  function degrade(st, err) {
    try { if (typeof console !== 'undefined') console.warn('FxGoo degraded to CSS thumb:', err); } catch { /* noop */ }
    try {
      if (st.raf) cancelAnimationFrame(st.raf);
      st.raf = 0;
      if (st.sil && st.sil.svg.parentNode) st.sil.svg.parentNode.removeChild(st.sil.svg);
      st.sil = null;
      st.mode = 'fallback';
      if (st.thumb) {
        st.thumb.classList.add('fxgoo-fallback');
        const lin = compileLinear(SEG_SPRING);
        st.thumb.style.transitionDuration = lin.duration + 'ms';
        st.thumb.style.transitionTimingFunction = lin.easing;
        if (!st.thumb.parentNode) st.el.insertBefore(st.thumb, st.el.firstChild);
      }
      st.el.classList.remove('fxgoo-live');
      if (st.place) st.place();
    } catch { /* even the fallback failed: leave the plain buttons */ }
  }

  /* ── segThumb: liquid sliding thumb for .seg[role=tablist] ── */
  /* opts.move (MoveTuning) retunes the whole feel; the default keeps the
     app's measured SEG_SPRING character with the library's tail/stretch. */
  function segThumb(segEl, opts) {
    if (!segEl || states.has(segEl)) return states.get(segEl) || null;
    const st = {
      el: segEl, mode: 'goo', raf: 0, dead: false, snapNext: true,
      sim: null, tailX: 0, tailVx: 0, tailR: 0, tailPhase: 0, lastTail: '',
      wave: 0, lastWave: '', lastPaint: '', sil: null, thumb: null, parts: null,
      mv: (opts && opts.move) ? mapMove(opts.move)
        : { stiffness: SEG_SPRING.stiffness, damping: SEG_SPRING.damping,
            stretch: MOVE.stretch, tail: MOVE.tail, force: MOVE.force },
    };
    states.set(segEl, st);
    try {
      st.thumb = document.createElement('div');
      st.thumb.className = 'fxgoo-thumb';
      const selected = () => segEl.querySelector('button[aria-selected="true"]');
      const measure = () => {
        const b = selected();
        if (!b) return null;
        return { x: b.offsetLeft, y: b.offsetTop, w: b.offsetWidth, h: b.offsetHeight };
      };
      st.place = () => { /* direct, unanimated placement (reduced / fallback / snap) */
        const m = measure();
        if (!m) { st.thumb.style.opacity = '0'; return; }
        st.thumb.style.opacity = '1';
        st.thumb.style.transform = 'translate(' + m.x + 'px,' + m.y + 'px)';
        st.thumb.style.width = m.w + 'px';
        st.thumb.style.height = m.h + 'px';
        if (st.sim) { st.sim.cx = m.x + m.w / 2; st.sim.vcx = 0; st.sim.w = m.w; st.sim.vw = 0; }
      };

      /* Observers register BEFORE the goo build: even a construction failure
         must leave a thumb that still follows the selection. */
      const onMutate = () => {
        if (st.dead) return;
        if (st.mode === 'goo') wakeLoop(st);
        else st.place();
      };
      st.mo = new MutationObserver(onMutate);
      st.mo.observe(segEl, { attributes: true, attributeFilter: ['aria-selected'], subtree: true, childList: true });
      st.ro = new ResizeObserver(() => {
        if (st.dead) return;
        st.snapNext = true; /* layout shifts reposition, they do not animate */
        if (st.mode === 'goo') wakeLoop(st); else st.place();
      });
      st.ro.observe(segEl);

      if (REDUCED) {
        /* Reduced motion: instant repositioning, no goo, no rAF — ever. */
        st.mode = 'reduced';
        segEl.insertBefore(st.thumb, segEl.firstChild);
        st.place();
      } else {
        /* Opaque ink (see the --goo-ink note in the styles block): the goo
           threshold erases translucent fills, so the silhouette paints the
           surface-3 equivalent and the crisp thumb tints it from above. */
        st.sil = buildSilhouette('var(--goo-ink, #323440)', true, { wavy: true });
        st.parts = st.sil;
        segEl.insertBefore(st.sil.svg, segEl.firstChild);
        segEl.insertBefore(st.thumb, st.sil.svg.nextSibling);
        segEl.classList.add('fxgoo-live');
        st.frame = (dt) => {
          const m = measure();
          /* A zero-size measurement is a hidden pane (offsetWidth of a
             display:none'd button is 0): springing toward it would carry
             the rect through negative widths — invalid SVG, console
             errors. Hide instead, and snap on the next real geometry. */
          if (!m || m.w === 0) { st.thumb.style.opacity = '0'; st.snapNext = true; return false; }
          st.thumb.style.opacity = '1';
          const tcx = m.x + m.w / 2;
          if (!st.sim || st.snapNext) {
            st.sim = { cx: tcx, vcx: 0, w: m.w, vw: 0 };
            st.snapNext = false;
          }
          const s = st.sim;
          [s.cx, s.vcx] = springSteps(s.cx, s.vcx, tcx, st.mv.stiffness, st.mv.damping, 1, dt);
          [s.w, s.vw] = springSteps(s.w, s.vw, m.w, st.mv.stiffness, st.mv.damping, 1, dt);
          const speed = Math.abs(s.vcx);
          const cy = m.y + m.h / 2;
          /* Mild stretch along the travel axis; the drop shape itself comes
             from the trailing droplet, not from squashing the body. */
          const stt = Math.min(st.mv.stretch, speed * 0.0006);
          const x = s.cx - s.w / 2;
          const body = st.sil.body;
          /* Belt over the braces above: the hidden-pane gate stops the 0
             target, but SEG_SPRING's tuned overshoot means ANY collapsing
             target can graze negative for a frame — clamp every geometric
             write so an invalid rect can never reach the DOM. */
          const wPx = Math.max(0, q(s.w, 0.1));
          const hPx = Math.max(0, q(m.h, 0.1));
          const paint = q(x, 0.1) + '|' + wPx + '|' + q(m.y, 0.1) + '|' + hPx + '|' + q(stt, 0.001);
          if (paint !== st.lastPaint) {
            body.setAttribute('x', String(q(x, 0.1)));
            body.setAttribute('y', String(q(m.y, 0.1)));
            body.setAttribute('width', String(wPx));
            body.setAttribute('height', String(hPx));
            body.setAttribute('transform', stt > 0.001
              ? 'translate(' + q(s.cx, 0.1) + ' ' + q(cy, 0.1) + ') scale(' + (1 + stt).toFixed(3) + ' ' +
                (1 / (1 + stt * 0.65)).toFixed(3) + ') translate(' + q(-s.cx, 0.1) + ' ' + q(-cy, 0.1) + ')'
              : '');
            st.thumb.style.transform = 'translate(' + q(x, 0.1) + 'px,' + m.y + 'px)';
            st.thumb.style.width = wPx + 'px';
            st.thumb.style.height = m.h + 'px';
            st.lastPaint = paint;
          }
          stepTail(st, s.cx, cy, speed, s.w, m.h, dt);
          const calm = stepWave(st, speed, dt);
          const settled = Math.abs(s.cx - tcx) < 0.05 && Math.abs(s.w - m.w) < 0.05 &&
            speed < 1 && Math.abs(s.vw) < 1 && st.tailR < 0.3 && calm;
          return !settled;
        };
        st.frame(0.001); /* first paint, parked on the selected button */
        wakeLoop(st);
      }
    } catch (err) {
      degrade(st, err);
    }
    return st;
  }

  /* ── slider: liquid-rubber trail on an <input type=range> thumb ── */
  /* opts.move (MoveTuning) retunes the chase; the default IS the library's
     MOVE_DEFAULTS — mapMove with no tuning reproduces them exactly. */
  function slider(inputEl, opts) {
    if (!inputEl || states.has(inputEl)) return states.get(inputEl) || null;
    if (REDUCED) return null; /* no goo, the native thumb already snaps */
    const st = {
      el: inputEl, mode: 'goo', raf: 0, dead: false,
      sim: null, tailX: 0, tailVx: 0, tailR: 0, tailPhase: 0, lastTail: '',
      wave: 0, lastWave: '', lastPaint: '', sil: null, parts: null, thumb: null,
      place: () => {}, listeners: [], mv: mapMove(opts && opts.move),
    };
    states.set(inputEl, st);
    try {
      const host = inputEl.parentElement;
      if (!host) throw new Error('range input has no parent to host the silhouette');
      if (getComputedStyle(host).position === 'static') host.classList.add('fxgoo-host');
      inputEl.classList.add('fxgoo-range');
      st.sil = buildSilhouette('var(--accent, #0A84FF)', false, { wavy: true });
      st.parts = st.sil;
      st.sil.svg.classList.add('fxgoo-sil-slider');
      host.insertBefore(st.sil.svg, inputEl);
      const R = 8; /* native thumb is ~16px */
      const center = () => {
        const min = parseFloat(inputEl.min) || 0;
        const max = parseFloat(inputEl.max) || 0;
        const val = parseFloat(inputEl.value) || 0;
        const ratio = max > min ? (val - min) / (max - min) : 0;
        const track = Math.max(0, inputEl.offsetWidth - R * 2);
        return {
          cx: inputEl.offsetLeft + R + ratio * track,
          cy: inputEl.offsetTop + inputEl.offsetHeight / 2,
        };
      };
      st.sim = { cx: center().cx, vcx: 0 }; /* park at rest so the FIRST move trails */
      st.frame = (dt) => {
        const t = center();
        if (!st.sim) st.sim = { cx: t.cx, vcx: 0 }; /* after a resize: snap, not animate */
        const s = st.sim;
        [s.cx, s.vcx] = springSteps(s.cx, s.vcx, t.cx, st.mv.stiffness, st.mv.damping, 1, dt);
        const speed = Math.abs(s.vcx);
        const stt = Math.min(st.mv.stretch, speed * 0.0006);
        const calm = stepWave(st, speed, dt);
        const settled = Math.abs(s.cx - t.cx) < 0.05 && speed < 1 && st.tailR < 0.3 && calm;
        const body = st.sil.body;
        /* The body blob only shows while the liquid actually trails; parked,
           the silhouette is empty and the native thumb stands alone. */
        const rNow = settled ? 0 : R;
        const paint = q(s.cx, 0.1) + '|' + rNow + '|' + q(stt, 0.001);
        if (paint !== st.lastPaint) {
          body.setAttribute('x', String(q(s.cx - R, 0.1)));
          body.setAttribute('y', String(q(t.cy - R, 0.1)));
          body.setAttribute('width', String(R * 2));
          body.setAttribute('height', String(rNow ? R * 2 : 0));
          body.setAttribute('rx', String(R));
          body.setAttribute('transform', stt > 0.001
            ? 'translate(' + q(s.cx, 0.1) + ' ' + q(t.cy, 0.1) + ') scale(' + (1 + stt).toFixed(3) + ' ' +
              (1 / (1 + stt * 0.65)).toFixed(3) + ') translate(' + q(-s.cx, 0.1) + ' ' + q(-t.cy, 0.1) + ')'
            : '');
          st.lastPaint = paint;
        }
        stepTail(st, s.cx, t.cy, speed, R * 2, R * 2, dt);
        return !settled;
      };
      const wake = () => { if (!st.dead) wakeLoop(st); };
      for (const type of ['input', 'change', 'pointerdown']) {
        inputEl.addEventListener(type, wake);
        st.listeners.push([inputEl, type, wake]);
      }
      st.ro = new ResizeObserver(() => { st.sim = null; wake(); });
      st.ro.observe(inputEl);
    } catch (err) {
      /* A broken trail must not break the scrubber: remove the overlay. */
      try {
        if (st.sil && st.sil.svg.parentNode) st.sil.svg.parentNode.removeChild(st.sil.svg);
      } catch { /* noop */ }
      st.dead = true;
      try { if (typeof console !== 'undefined') console.warn('FxGoo slider disabled:', err); } catch { /* noop */ }
    }
    return st;
  }

  /* ── detachPair: a two-item goo group (EmailInput.tsx, made vanilla) ──
     The field and its satellite button read as ONE merged liquid at rest —
     the resting layout gap sits inside the 8/22 goo's bridging distance —
     and focusing the field liquid-splits the button out past bridging
     (600ms cubic-bezier(0.22, 1.3, 0.71, 1)). Blur merges it back behind
     the PlusMenu anticipation dip: 5px toward the returning momentum over
     700ms. DOM order and a11y never change — the crisp mover rides above
     on a translateX custom property, the silhouette mirrors both below,
     and any throw degrades to a plain CSS transition on that same property
     (the segThumb fallback contract: the controls must never look broken).
     fieldShift defaults to 0 ON PURPOSE: a transform is a stacking context,
     and a field that anchors a z-indexed panel (the query hints) must never
     trap it — hosts without anchored overlays can opt the lean in. */
  const PAIR_EASE = [0.22, 1.3, 0.71, 1];
  function detachPair(fieldEl, buttonEl, opts) {
    if (!fieldEl || !buttonEl || states.has(fieldEl)) return states.get(fieldEl) || null;
    if (REDUCED) return null; /* the resting layout IS the reduced design */
    opts = opts || {};
    const st = {
      el: fieldEl, btn: buttonEl, mode: 'pair', raf: 0, dead: false,
      mix: 0, anim: null, dipT: Infinity, lastPaint: '', sil: null,
      btnBody: null, listeners: [], place: () => {}, onFail: degradePair,
    };
    states.set(fieldEl, st);
    const dur = (opts.duration || 600) / 1000;
    const fieldShift = opts.fieldShift != null ? opts.fieldShift : 0;
    const buttonShift = opts.buttonShift != null ? opts.buttonShift : 15;
    st.fieldMoves = fieldShift !== 0;
    const focusEl = opts.focusEl || fieldEl;
    const ease = bezierEase(PAIR_EASE[0], PAIR_EASE[1], PAIR_EASE[2], PAIR_EASE[3]);
    /* Listeners and cleanup register BEFORE the goo build (the segThumb
       ordering): even a construction failure leaves a pair that still
       splits, carried by the fallback CSS transition. */
    const setDx = (px) => {
      buttonEl.style.setProperty('--fxgoo-dx', px.b + 'px');
      if (st.fieldMoves) fieldEl.style.setProperty('--fxgoo-dx', px.f + 'px');
    };
    const toward = (target) => {
      if (st.dead) return;
      if (st.mode === 'fallback') {
        /* End values only — the .fxgoo-fallback transition does the easing. */
        setDx({ f: target * fieldShift, b: target * buttonShift });
        st.mix = target;
        return;
      }
      st.anim = { from: st.mix, to: target, t: 0 };
      if (target === 0) st.dipT = 0; /* merge-back arms the anticipation dip */
      wakeLoop(st);
    };
    const onFocus = () => toward(1);
    const onBlur = () => toward(0);
    focusEl.addEventListener('focus', onFocus);
    focusEl.addEventListener('blur', onBlur);
    st.listeners.push([focusEl, 'focus', onFocus], [focusEl, 'blur', onBlur]);
    st.cleanup = () => {
      fieldEl.classList.remove('fxgoo-pair-item', 'fxgoo-fallback');
      buttonEl.classList.remove('fxgoo-pair-item', 'fxgoo-fallback');
      fieldEl.style.removeProperty('--fxgoo-dx');
      buttonEl.style.removeProperty('--fxgoo-dx');
    };
    try {
      const host = fieldEl.parentElement;
      if (!host) throw new Error('detach pair has no shared parent to host the silhouette');
      if (getComputedStyle(host).position === 'static') host.classList.add('fxgoo-host');
      /* Opaque ink (see --goo-ink-2): translucent fills die in the goo
         threshold. Deluxe, so the merged pill carries the app's ring +
         shine chrome like every other raised control. */
      st.sil = buildSilhouette(opts.fill || 'var(--goo-ink-2, #282a33)', true,
        { blur: 8, contrast: 22 });
      st.sil.svg.classList.add('fxgoo-sil-pair');
      /* Second body: the button's mirrored blob shares the field's filter,
         which is what lets the two bridge and neck as one liquid. */
      st.btnBody = svgEl('rect', { x: '0', y: '0', width: '0', height: '0',
        rx: String(opts.buttonRadius != null ? opts.buttonRadius : 9) });
      st.sil.group.appendChild(st.btnBody);
      st.sil.body.setAttribute('rx', String(opts.fieldRadius != null ? opts.fieldRadius : 10));
      host.insertBefore(st.sil.svg, host.firstChild);
      /* Only movers are decorated — the class carries a transform, and a
         transform on a never-moving field would still cost it a stacking
         context (see the fieldShift note above). */
      buttonEl.classList.add('fxgoo-pair-item');
      if (st.fieldMoves) fieldEl.classList.add('fxgoo-pair-item');
      st.frame = (dt) => {
        let live = false;
        if (st.anim) {
          st.anim.t += dt;
          const p = Math.min(1, st.anim.t / dur);
          st.mix = st.anim.from + (st.anim.to - st.anim.from) * ease(p);
          if (p >= 1) { st.mix = st.anim.to; st.anim = null; } else live = true;
        }
        let dip = 0;
        if (st.dipT < 0.7) {
          /* The liquid dips toward the returning button's momentum, and the
             neck absorbs it into the resting body. */
          dip = -5 * Math.sin(Math.PI * (st.dipT / 0.7));
          st.dipT += dt;
          if (st.dipT >= 0.7) dip = 0; else live = true;
        }
        const fx = st.mix * fieldShift + (st.fieldMoves ? dip : 0);
        const bx = st.mix * buttonShift + dip;
        setDx({ f: q(fx, 0.1), b: q(bx, 0.1) });
        const fX = fieldEl.offsetLeft + fx, fY = fieldEl.offsetTop;
        const fW = fieldEl.offsetWidth, fH = fieldEl.offsetHeight;
        const bX = buttonEl.offsetLeft + bx, bY = buttonEl.offsetTop;
        const bW = buttonEl.offsetWidth, bH = buttonEl.offsetHeight;
        /* Zero-size measurements are a hidden ancestor (the segThumb gate):
           park both bodies empty and repaint on the next real geometry. */
        const paint = fW === 0 || bW === 0 ? 'hidden'
          : q(fX, 0.1) + '|' + q(bX, 0.1) + '|' + fW + '|' + bW + '|' + q(fY, 0.1) + '|' + q(bY, 0.1);
        if (paint !== st.lastPaint) {
          if (paint === 'hidden') {
            st.sil.body.setAttribute('width', '0');
            st.btnBody.setAttribute('width', '0');
          } else {
            st.sil.body.setAttribute('x', String(q(fX, 0.1)));
            st.sil.body.setAttribute('y', String(q(fY, 0.1)));
            st.sil.body.setAttribute('width', String(fW));
            st.sil.body.setAttribute('height', String(fH));
            st.btnBody.setAttribute('x', String(q(bX, 0.1)));
            st.btnBody.setAttribute('y', String(q(bY, 0.1)));
            st.btnBody.setAttribute('width', String(bW));
            st.btnBody.setAttribute('height', String(bH));
          }
          st.lastPaint = paint;
        }
        return live;
      };
      st.ro = new ResizeObserver(() => { if (!st.dead && st.mode === 'pair') wakeLoop(st); });
      st.ro.observe(host);
      st.frame(0.0001); /* first paint: merged at rest */
    } catch (err) {
      degradePair(st, err);
    }
    return st;
  }

  /* The pair's fallback: strip the goo, keep the split — end values on the
     same custom property, eased by the .fxgoo-fallback CSS transition. */
  function degradePair(st, err) {
    try { if (typeof console !== 'undefined') console.warn('FxGoo detachPair degraded to CSS:', err); } catch { /* noop */ }
    try {
      if (st.raf) cancelAnimationFrame(st.raf);
      st.raf = 0;
      st.anim = null;
      st.dipT = Infinity;
      if (st.sil && st.sil.svg.parentNode) st.sil.svg.parentNode.removeChild(st.sil.svg);
      st.sil = null;
      st.mode = 'fallback';
      if (st.btn && st.btn.classList) st.btn.classList.add('fxgoo-pair-item', 'fxgoo-fallback');
      /* The field is decorated only when it moves — same stacking-context
         reasoning as the live path. */
      if (st.fieldMoves) st.el.classList.add('fxgoo-pair-item', 'fxgoo-fallback');
    } catch { /* even the fallback failed: leave the plain controls */ }
  }

  /* ── bend: the liquid body arcs under a pull (observer.ts:1415–1478) ──
     The library's exact deformation: vertical pull bows the top and bottom
     edges as quadratic sags (middle leads, control point 2b), horizontal
     pull reshapes the pill CAPS — the leading cap blunts against the flow
     (r − 0.8k), the trailing cap stretches out behind (r + 1.6k) — and the
     quarter-circles are drawn as K=0.5523 cubics. A rect cannot arc, so the
     silhouette body is a <path>, and the live bend is published as
     --lg-bend-x/-y (plus unitless -xn/-yn) so the content can lean along. */
  const BEND = { vertical: 0.6, horizontal: 0.35 }; /* BendTuning defaults */
  function bendPath(bw, bh, r, bendCur, bendCurX) {
    const rr = Math.min(r, bw / 2, bh / 2);
    const cyO = Math.round(bendCur * 2 * 10) / 10;
    const k = bendCurX;
    const rxR = Math.max(rr * 0.2, Math.min(rr * 3, k > 0 ? rr - 0.8 * k : rr + 1.6 * -k));
    const rxL = Math.max(rr * 0.2, Math.min(rr * 3, k > 0 ? rr + 1.6 * k : rr - 0.8 * -k));
    const K = 0.5523; /* quarter-circle as cubic: control offset K·radius */
    const f = (v) => Math.round(v * 10) / 10;
    return 'M ' + f(rxL) + ' 0 Q ' + f(bw / 2) + ' ' + cyO + ' ' + f(bw - rxR) + ' 0 ' +
      'C ' + f(bw - rxR + K * rxR) + ' 0 ' + f(bw) + ' ' + f(rr - K * rr) + ' ' + f(bw) + ' ' + f(rr) + ' ' +
      'L ' + f(bw) + ' ' + f(bh - rr) + ' ' +
      'C ' + f(bw) + ' ' + f(bh - rr + K * rr) + ' ' + f(bw - rxR + K * rxR) + ' ' + f(bh) + ' ' + f(bw - rxR) + ' ' + f(bh) + ' ' +
      'Q ' + f(bw / 2) + ' ' + f(bh + bendCur * 2) + ' ' + f(rxL) + ' ' + f(bh) + ' ' +
      'C ' + f(rxL - K * rxL) + ' ' + f(bh) + ' 0 ' + f(bh - rr + K * rr) + ' 0 ' + f(bh - rr) + ' ' +
      'L 0 ' + f(rr) + ' ' +
      'C 0 ' + f(rr - K * rr) + ' ' + f(rxL - K * rxL) + ' 0 ' + f(rxL) + ' 0 Z';
  }

  /* bendAttach/bendPull/bendRelease: a transient liquid body on a hover
     target. Attach is idempotent (keyed on the element); pull takes the
     hover point normalized to [-1, 1] per axis; release springs flat and
     then tears the whole thing down — the mount destroys itself the moment
     its state ends, so no caller has to remember a settle timer. */
  function bendAttach(el, opts) {
    if (!el || states.has(el)) return states.get(el) || null;
    if (REDUCED) return null; /* a still tile is the reduced design */
    opts = opts || {};
    const st = {
      el, mode: 'bend', raf: 0, dead: false, sil: null, path: null,
      bendCur: 0, bendCurX: 0, targetY: 0, targetX: 0, releasing: false,
      lastPaint: '', lastVars: '', listeners: [], place: () => {},
    };
    states.set(el, st);
    st.onFail = (s, err) => {
      /* Bend is decoration on a hover state: tear down completely. */
      try { if (typeof console !== 'undefined') console.warn('FxGoo bend disabled:', err); } catch { /* noop */ }
      detach(el);
    };
    try {
      const r = opts.radius != null ? opts.radius : 10;
      /* The host usually arrives positioned (the drag beam runs first);
         the class is belt-and-braces and stays — position: relative on a
         tile is layout-safe, and removing it could strand a live beam. */
      if (getComputedStyle(el).position === 'static') el.classList.add('fxgoo-host');
      /* Opaque ink (see --goo-ink-2): the tile's own translucent surface
         tints it from above, and the bulges outside the tile paint clean. */
      st.sil = buildSilhouette(opts.fill || 'var(--goo-ink-2, #282a33)', false);
      st.sil.svg.classList.add('fxgoo-sil-bend');
      st.path = svgEl('path', { d: '' });
      st.sil.group.appendChild(st.path);
      el.insertBefore(st.sil.svg, el.firstChild);
      el.classList.add('fxgoo-bending');
      st.cleanup = () => {
        el.classList.remove('fxgoo-bending');
        el.style.removeProperty('--lg-bend-x');
        el.style.removeProperty('--lg-bend-y');
        el.style.removeProperty('--lg-bend-xn');
        el.style.removeProperty('--lg-bend-yn');
      };
      st.frame = (dt) => {
        const bw = el.offsetWidth, bh = el.offsetHeight;
        st.bendCur += (st.targetY - st.bendCur) * Math.min(1, dt * 9);
        st.bendCurX += (st.targetX - st.bendCurX) * Math.min(1, dt * 9);
        const bvx = Math.round(st.bendCurX * 10) / 10;
        const bvy = Math.round(st.bendCur * 10) / 10;
        const vars = bvx + ',' + bvy;
        if (vars !== st.lastVars) {
          el.style.setProperty('--lg-bend-x', bvx + 'px');
          el.style.setProperty('--lg-bend-y', bvy + 'px');
          el.style.setProperty('--lg-bend-xn', String(bvx));
          el.style.setProperty('--lg-bend-yn', String(bvy));
          st.lastVars = vars;
        }
        if (bw > 1 && bh > 1) {
          const d = bendPath(bw, bh, r, st.bendCur, st.bendCurX);
          if (d !== st.lastPaint) { st.path.setAttribute('d', d); st.lastPaint = d; }
        }
        const settled = Math.abs(st.bendCur - st.targetY) < 0.1 && Math.abs(st.bendCurX - st.targetX) < 0.1;
        if (st.releasing && settled) { detach(el); return false; }
        return !settled;
      };
      st.frame(0.0001);
    } catch (err) {
      st.onFail(st, err);
      return null;
    }
    return st;
  }
  function bendPull(el, nx, ny) {
    const st = states.get(el);
    if (!st || st.mode !== 'bend' || st.dead) return;
    /* The upstream caps bound the deformation (vertical min(w,h)·0.5); the
       pull maps the hover point to a modest fraction of them so a corner
       hover leans hardest and the centre barely moves. */
    const cap = Math.min(el.offsetWidth, el.offsetHeight) * 0.5;
    st.targetY = Math.max(-1, Math.min(1, ny || 0)) * cap * 0.6 * BEND.vertical;
    st.targetX = Math.max(-1, Math.min(1, nx || 0)) * cap * 0.6 * BEND.horizontal;
    st.releasing = false;
    wakeLoop(st);
  }
  function bendRelease(el) {
    const st = states.get(el);
    if (!st || st.mode !== 'bend' || st.dead) return;
    st.targetX = 0;
    st.targetY = 0;
    st.releasing = true;
    wakeLoop(st);
  }

  function detach(el) {
    const st = states.get(el);
    if (!st) return;
    st.dead = true;
    if (st.raf) cancelAnimationFrame(st.raf);
    st.raf = 0;
    if (st.mo) st.mo.disconnect();
    if (st.ro) st.ro.disconnect();
    for (const [target, type, fn] of st.listeners || []) target.removeEventListener(type, fn);
    if (st.sil && st.sil.svg.parentNode) st.sil.svg.parentNode.removeChild(st.sil.svg);
    if (st.thumb && st.thumb.parentNode) st.thumb.parentNode.removeChild(st.thumb);
    if (st.el && st.el.classList) st.el.classList.remove('fxgoo-live');
    if (st.cleanup) { try { st.cleanup(); } catch { /* noop */ } }
    states.delete(el);
  }

  return { segThumb, slider, spring, detach, detachPair, bendAttach, bendPull, bendRelease,
    bendPath, simulate, compileLinear, mapMove, presets, SEG_SPRING, MOVE, BEND };
})();
/* ═══ end FX: Liquid Goo ═══ */
/**
 * The one fetch wrapper (§3.4). Every network call in this file goes through
 * it — there are no other `fetch()` call sites, and a test pins that.
 *
 * It owns six things so no caller has to:
 *
 *  - **The error envelope.** The backend answers failures as flat
 *    `{ error, code }` (src/middleware/errorHandler.ts). That is NOT the nested
 *    `{ error: { code, message } }` shape the spec sketches; §3.2 says to follow
 *    the existing convention, so this reads the flat one and every caller
 *    switches on `err.code`, never on message text.
 *  - **Rate limiting.** Retried with backoff. A surfaced 429 used to read as
 *    "your delete failed" or, worse, made a folder render as empty.
 *  - **202 pending.** Long work answers `202 { status: 'running' }` until it is
 *    done. With `poll: true` the wrapper waits it out rather than making each
 *    panel write its own polling loop. Reaching a caller that did NOT ask to
 *    wait, that body is not a result: handing it back is how a card reads
 *    `.suggestions` off it and paints an empty list, which is the silent blank
 *    §3.5 forbids. So it throws, marked `stillWorking` and carrying whatever
 *    progress the body had. `pending: 'return'` opts out, for the two finders
 *    that run their own loop in order to paint a progress bar from it.
 *  - **Capability failures.** `409 CAPABILITY_UNAVAILABLE` carries a
 *    human-readable reason; it is marked so panels can render the *unavailable*
 *    state (§3.5 #5) instead of an error.
 *  - **A body that is not JSON.** A truncated or intercepted 2xx used to parse
 *    to `null` and be returned as if it were the answer, so the caller either
 *    threw a `TypeError` at the user or painted an empty card. It is an error
 *    now, in words, and the raw parser message never reaches a reader.
 *  - **A dropped connection.** `fetch` rejects with the browser's own sentence
 *    — "Failed to fetch", "Load failed", "NetworkError…" — which names neither
 *    what was unreachable nor what to do. Replaced with one that does. A
 *    request the app itself aborted passes through untouched, because that is
 *    not a failure at all.
 *
 * Throws on failure. Callers catch and pass the error to `reportError`, which
 * is the single place an error becomes something the user sees.
 */
async function api(url, options, opts = {}) {
  const { retries = 8, poll = false, pollMs = 700, pollTimeoutMs = 120000, pending = 'throw' } = opts;
  const deadline = Date.now() + pollTimeoutMs;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (netErr) {
      if (netErr && netErr.name === 'AbortError') throw netErr; // the app cancelled it; not a failure
      const err = new Error('Couldn’t reach TreeMap — its own server stopped answering. Check the app is still running, then try again.');
      err.code = 'OFFLINE';
      err.status = 0;
      throw err;
    }

    // Read the body ONCE, as text, so "carried nothing" can be told apart from
    // "carried something that is not JSON". `res.json()` collapses both to a
    // throw, which is what let an unreadable answer pass as an empty one.
    let raw = '';
    try { raw = await res.text(); } catch { /* body already gone */ }
    let body = null;
    let unreadable = false;
    if (raw) { try { body = JSON.parse(raw); } catch { unreadable = true; } }

    if (res.status === 429 && attempt < retries) {
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); // refill is 10/s
      continue;
    }

    // 202 means "still working" — the shape every long-running endpoint uses.
    if (res.status === 202 && poll) {
      if (Date.now() > deadline) {
        const err = new Error('This is still running after a long wait. It may still finish — reopen this in a moment to check.');
        err.code = 'PENDING_TIMEOUT';
        err.status = 202;
        err.pending = body;
        throw err;
      }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    // The same 202, reaching a caller that did not ask to wait. A job HANDLE is
    // a real payload and still returns: POST /api/scan and POST /api/index/build
    // both answer 202 with the id the caller needs, and the id is what tells
    // the two apart from "no answer yet".
    if (res.status === 202 && pending === 'throw' && body &&
        body.status === 'running' && !body.jobId && !body.scanId) {
      const err = new Error('Still working on that — it hasn’t finished yet. Try again in a moment.');
      err.code = 'PENDING';
      err.status = 202;
      err.pending = body;
      err.stillWorking = true;
      throw err;
    }

    if (!res.ok) {
      // An error whose body is not JSON (a proxy's HTML page, a truncated
      // stream) still has its status to report, and that is more use to a
      // reader than a parser's complaint about an unexpected token.
      const err = new Error((body && body.error) || ('The server answered ' + res.status + ' with nothing TreeMap could read.'));
      err.code = (body && body.code) || 'HTTP_' + res.status;
      err.status = res.status;
      // Some errors carry machine-readable specifics alongside the prose —
      // B2's OPEN_HANDLE_CONFLICT ships the offending processes so the dialog
      // can name them. The envelope is flat, so anything beyond error/code is
      // carried straight onto the error rather than being dropped here.
      if (body) for (const k of Object.keys(body)) if (k !== 'error' && k !== 'code') err[k] = body[k];
      // Not a failure so much as an answer: this machine cannot do that.
      err.capabilityUnavailable = err.code === 'CAPABILITY_UNAVAILABLE';
      throw err;
    }

    if (unreadable) {
      const err = new Error('TreeMap couldn’t read the answer its own server sent. Try again.');
      err.code = 'BAD_RESPONSE';
      err.status = res.status;
      throw err;
    }
    return body;
  }
}

/**
 * The single place an error becomes something the user sees (§3.4).
 *
 * `message` from the envelope is written for a non-technical reader, so it goes
 * on screen as-is. Two things that arrive here are not errors and must not be
 * dressed as one: a capability this machine does not have, and work that has
 * not finished. Both are answers, so both are shown plainly rather than in red.
 * A cancelled request says nothing at all.
 */
function reportError(err, context) {
  if (!err || err.name === 'AbortError') return;
  const detail = err.message || 'Something went wrong.';
  if (err.capabilityUnavailable || err.stillWorking) { toast(detail, 'success', 6000); return; }
  toast(context ? context + ': ' + detail : detail, 'error');
}
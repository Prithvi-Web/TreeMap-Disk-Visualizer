/* ═══════════════ Liquid Glass engine ═══════════════
   Vanilla port of rdev/liquid-glass-react (MIT): per-element SVG displacement
   filters applied through backdrop-filter, giving true edge refraction with
   chromatic aberration. Elements keep working with plain frosted blur if this
   never runs — the engine only ever ADDS the lens on top. */
(() => {
  'use strict';
  try {
    const svgNS = 'http://www.w3.org/2000/svg';
    const host = document.createElementNS(svgNS, 'svg');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
    const defs = document.createElementNS(svgNS, 'defs');
    host.appendChild(defs);
    document.body.appendChild(host);

    /* Rounded-rect SDF displacement map (X→red, Y→green+blue), cached per size bucket. */
    const smooth = (a, b, t) => { t = Math.max(0, Math.min(1, (t - a) / (b - a))); return t * t * (3 - 2 * t); };
    const sdf = (x, y, w, h, r) => {
      const qx = Math.abs(x) - w + r, qy = Math.abs(y) - h + r;
      return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
    };
    const mapCache = new Map();
    function makeMap(w, h) {
      const key = w + 'x' + h;
      let url = mapCache.get(key);
      if (url) return url;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      let maxS = 0; const raw = new Float32Array(w * h * 2);
      let i = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const ix = x / w - 0.5, iy = y / h - 0.5;
        const scaled = smooth(0, 1, smooth(0.8, 0, sdf(ix, iy, 0.3, 0.2, 0.6) - 0.15));
        const dx = (ix * scaled + 0.5) * w - x, dy = (iy * scaled + 0.5) * h - y;
        if (Math.abs(dx) > maxS) maxS = Math.abs(dx);
        if (Math.abs(dy) > maxS) maxS = Math.abs(dy);
        raw[i++] = dx; raw[i++] = dy;
      }
      maxS = Math.max(maxS, 1);
      const img = ctx.createImageData(w, h); const d = img.data;
      i = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const edge = Math.min(1, Math.min(x, y, w - x - 1, h - y - 1) / 2);
        const r = (raw[i++] * edge) / maxS + 0.5, g = (raw[i++] * edge) / maxS + 0.5;
        const p = (y * w + x) * 4;
        d[p] = Math.max(0, Math.min(255, r * 255));
        d[p + 1] = Math.max(0, Math.min(255, g * 255));
        d[p + 2] = d[p + 1];
        d[p + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      url = cv.toDataURL();
      if (mapCache.size >= 48) mapCache.delete(mapCache.keys().next().value);
      mapCache.set(key, url);
      return url;
    }

    /* Full liquid-glass filter chain: edge-masked RGB-split displacement. */
    function buildFilter(id, mapUrl, scale, ab) {
      const old = document.getElementById(id);
      if (old) old.remove();
      const f = document.createElementNS(svgNS, 'filter');
      f.setAttribute('id', id);
      f.setAttribute('x', '-35%'); f.setAttribute('y', '-35%');
      f.setAttribute('width', '170%'); f.setAttribute('height', '170%');
      f.setAttribute('color-interpolation-filters', 'sRGB');
      const prim = (tag, attrs, parent) => {
        const el = document.createElementNS(svgNS, tag);
        for (const k in attrs) el.setAttribute(k, attrs[k]);
        (parent || f).appendChild(el);
        return el;
      };
      prim('feImage', { href: mapUrl, x: 0, y: 0, width: '100%', height: '100%', result: 'MAP', preserveAspectRatio: 'xMidYMid slice' });
      prim('feColorMatrix', { in: 'MAP', type: 'matrix', values: '0.3 0.3 0.3 0 0 0.3 0.3 0.3 0 0 0.3 0.3 0.3 0 0 0 0 0 1 0', result: 'EDGE_INT' });
      const ct = prim('feComponentTransfer', { in: 'EDGE_INT', result: 'EDGE_MASK' });
      prim('feFuncA', { type: 'discrete', tableValues: '0 ' + (ab * 0.05) + ' 1' }, ct);
      prim('feOffset', { in: 'SourceGraphic', dx: 0, dy: 0, result: 'CENTER' });
      const chan = (sc, matrix, out) => {
        prim('feDisplacementMap', { in: 'SourceGraphic', in2: 'MAP', scale: sc, xChannelSelector: 'R', yChannelSelector: 'B', result: out + '_D' });
        prim('feColorMatrix', { in: out + '_D', type: 'matrix', values: matrix, result: out });
      };
      chan(scale, '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0', 'R');
      chan(scale - ab * 0.05 * Math.abs(scale), '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0', 'G');
      chan(scale - ab * 0.1 * Math.abs(scale), '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0', 'B');
      prim('feBlend', { in: 'G', in2: 'B', mode: 'screen', result: 'GB' });
      prim('feBlend', { in: 'R', in2: 'GB', mode: 'screen', result: 'RGBC' });
      prim('feGaussianBlur', { in: 'RGBC', stdDeviation: Math.max(0.1, 0.5 - ab * 0.1), result: 'ABB' });
      prim('feComposite', { in: 'ABB', in2: 'EDGE_MASK', operator: 'in', result: 'EDGE_AB' });
      const inv = prim('feComponentTransfer', { in: 'EDGE_MASK', result: 'INV' });
      prim('feFuncA', { type: 'table', tableValues: '1 0' }, inv);
      prim('feComposite', { in: 'CENTER', in2: 'INV', operator: 'in', result: 'CENTER_CLEAN' });
      prim('feComposite', { in: 'EDGE_AB', in2: 'CENTER_CLEAN', operator: 'over' });
      defs.appendChild(f);
    }

    /* Which elements get the lens, and how strong. */
    const TARGETS = [
      /* Owner's call, 2 Sep 2026 ("make it blazing fast in all areas"):
         the two largest lens surfaces keep their frost and drop the lens.
         The sidebar is 232px × window height and its collapse/expand crossed
         ~21 size buckets, each a displacement-map build on the main thread;
         a modal is the strongest lens here over up to 660×84vh and is
         re-composited on every scroll frame inside it. */
      ['#sideNav',      { scale: 22, ab: 1.5, plain: 1 }],
      ['.modal',        { scale: 44, ab: 2, plain: 1 }],
      ['#cartTab',      { scale: 34, ab: 2, track: 1 }],
      ['#cartPanel',    { scale: 40, ab: 2 }],
      ['#selectionBar', { scale: 34, ab: 2 }],
      ['#previewPane',  { scale: 40, ab: 2 }],
      ['#ctxMenu',      { scale: 26, ab: 1.5 }],
      ['#rcPopover',    { scale: 30, ab: 2 }],
      /* The tooltip follows the pointer every frame and re-sizes on every
         node. A url(#…) reference filter in backdrop-filter is rasterised
         against the moving backdrop each frame, and each new 8px size bucket
         cost a 4.6ms displacement-map build (measured) — so it keeps the
         frost and skips the lens. */
      ['#tooltip',      { scale: 20, ab: 1.5, plain: 1 }],
      ['.toast',        { scale: 28, ab: 2 }],
      ['.tm-timebar',   { scale: 26, ab: 1.5 }],
      ['#liveFeed',     { scale: 24, ab: 1.5 }],
    ];
    const SELECTOR = TARGETS.map(t => t[0]).join(',');
    const optsFor = el => { for (const [sel, o] of TARGETS) if (el.matches(sel)) return o; return null; };

    const MAX_AREA = 1800 * 1000;   /* beyond this, plain frost only */
    const bucket = n => Math.max(24, Math.round(n / 8) * 8);
    let uid = 0;
    const pending = new Set();
    let raf = 0;

    function refresh(el) {
      const st = el.__lg;
      if (!st || st.opts.plain) return;   /* frost only — nothing to build */
      const w0 = el.offsetWidth, h0 = el.offsetHeight;
      if (!w0 || !h0) return;                 /* hidden — observer refires on open */
      const w = bucket(w0), h = bucket(h0);
      const key = w + 'x' + h;
      if (st.key === key) return;
      st.key = key;
      if (w * h > MAX_AREA) { el.style.removeProperty('--lg-backdrop'); return; }
      buildFilter(st.id, makeMap(w, h), st.opts.scale, st.opts.ab);
      const cs = getComputedStyle(el);
      const blur = cs.getPropertyValue('--lg-blur').trim() || '22px';
      const sat = cs.getPropertyValue('--lg-sat').trim() || '185%';
      el.style.setProperty('--lg-backdrop', 'url(#' + st.id + ') blur(' + blur + ') saturate(' + sat + ')');
    }
    let timer = 0;
    function flush() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (timer) { clearTimeout(timer); timer = 0; }
      pending.forEach(el => { try { refresh(el); } catch (e) { /* one bad element must not wedge the queue */ } });
      pending.clear();
    }
    function schedule(el) {
      pending.add(el);
      /* rAF for visible pages; the timer covers hidden/occluded pages (tray launch,
         background window) where rAF and ResizeObserver are suspended. */
      if (!raf) raf = requestAnimationFrame(flush);
      if (!timer) timer = setTimeout(flush, 120);
    }

    const ro = new ResizeObserver(entries => { for (const e of entries) schedule(e.target); });

    function attach(el) {
      if (el.__lg) return;
      const opts = optsFor(el);
      if (!opts) return;
      /* plain: the frosted ::before is the whole surface. No filter is ever
         built, so the key is pre-set to keep scheduleUnbuilt from queueing
         it, and no observer is registered. */
      el.__lg = { id: 'lg-f-' + (++uid), opts, key: opts.plain ? 'plain' : '' };
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.classList.add('lg');
      if (opts.plain) return;
      if (opts.track) {
        el.addEventListener('pointermove', ev => {
          const r = el.getBoundingClientRect();
          const dx = (ev.clientX - (r.left + r.width / 2)) / Math.max(1, r.width);
          el.style.setProperty('--lg-angle', (135 + dx * 60) + 'deg');
        });
        el.addEventListener('pointerleave', () => el.style.removeProperty('--lg-angle'));
      }
      ro.observe(el);
      schedule(el);
    }

    function detach(el) {
      if (!el.__lg) return;
      const f = document.getElementById(el.__lg.id);
      if (f) f.remove();
      ro.unobserve(el);
      pending.delete(el);
      delete el.__lg;
    }
    /* Schedule any not-yet-built lens element in this subtree. Open/close is
       always an attribute flip (.open class, hidden attr, style.display), so
       watching attributes makes filter-building deterministic even where
       ResizeObserver is suspended (hidden or occluded windows). */
    function scheduleUnbuilt(el) {
      if (el.__lg && !el.__lg.key) schedule(el);
      if (el.querySelectorAll) el.querySelectorAll('.lg').forEach(c => { if (c.__lg && !c.__lg.key) schedule(c); });
    }
    document.querySelectorAll(SELECTOR).forEach(attach);
    new MutationObserver(muts => {
      /* Attribute records are the hot path: this observer watches `style` on
         the whole body subtree, and the app writes inline styles per frame
         (the beam pulse driver alone emits 17 records per driven instance
         per frame, each landing here). Two things keep that cheap. An
         element with no children that holds no lens can schedule nothing —
         scheduleUnbuilt would look at __lg and then search an empty subtree
         — so it is skipped outright. And one batch is one task's worth of
         records, so a target already looked at in this batch says nothing
         new. */
      let seen = null;
      for (const m of muts) {
        if (m.type === 'attributes') {
          const t = m.target;
          if (!t.__lg && !t.firstElementChild) continue;
          if (!seen) seen = new Set();
          if (seen.has(t)) continue;
          seen.add(t);
          scheduleUnbuilt(t);
          continue;
        }
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches(SELECTOR)) attach(n);
          if (n.querySelectorAll) n.querySelectorAll(SELECTOR).forEach(attach);
        }
        for (const n of m.removedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.__lg) detach(n);
          if (n.querySelectorAll) n.querySelectorAll('.lg').forEach(detach);
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  } catch (err) {
    /* Lens is decoration — the frosted fallback is always in place. */
    console.warn('Liquid Glass engine disabled:', err);
  }
})();
/* ═══ end Liquid Glass engine ═══ */
/* FX: Liquid Goo — liquid thumb on every segmented control, trail on the scrubber. */
for (const seg of document.querySelectorAll('.seg[role="tablist"]')) FxGoo.segThumb(seg);
/* The time-lapse scrubber runs a slightly bouncier MoveTuning profile than
   the segs: extra wobble and a longer trail read as playful on a playback
   control, where the same looseness on a mode switch would read as slop. */
if ($('tmTimeSlider')) FxGoo.slider($('tmTimeSlider'), { move: { wobble: 0.62, trail: 0.66, stretch: 0.4 } });
/* FX: Liquid Goo — the plain-words button rests merged into the search
   field's end as one liquid; focusing the field splits it out, blur merges
   it back behind the anticipation dip. DOM order and a11y untouched. */
FxGoo.detachPair($('tmSearchWrap'), $('tmNlBtn'), { focusEl: $('tmSearch') });
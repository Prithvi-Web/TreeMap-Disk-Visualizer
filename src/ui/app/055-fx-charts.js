/* ═══════════════ FX: Charts ═══════════════ */
/* FxCharts — a bklit-fidelity chart kit, blue/black, zero dependencies.
   Built ON the shared Canvas2D toolkit (Canvas2D.setup owns the dpr
   transform); bytes are formatted ONLY through the app's formatBytes;
   every animation entry point checks REDUCED; nothing runs while
   document.hidden; every handle is { update, destroy } and destroy
   actually releases rAF loops, observers, listeners and tooltip nodes.

   FxCharts.math is deliberately DOM-free: scales, nice ticks, monotone
   cubic smoothing, arc layout, color ramps and linear regression are
   pure functions the test suite evaluates in Node. */
const FxCharts = (() => {

  /* ── the blue ramp — the ONLY chart palette ─────────────────────────
     Derived from --accent #0A84FF, brightening toward ice, then falling
     back to desaturated slate blues for muted trailing series. */
  const FX_RAMP_CORE = ['#0A84FF', '#4DA3FF', '#86C1FF', '#B9DBFF'];
  const FX_RAMP_MUTED = ['#5E7FA6', '#46617F', '#8FA6C2', '#31465E'];

  /* ═════════════════════ pure math (no DOM) ═════════════════════ */
  const math = {
    /** Linear scale: domain → range, with the inverse for hit-testing. */
    scaleLinear(d0, d1, r0, r1) {
      const dd = (d1 - d0) || 1;
      return {
        to: (v) => r0 + ((v - d0) / dd) * (r1 - r0),
        from: (px) => d0 + ((px - r0) / ((r1 - r0) || 1)) * dd,
      };
    },

    /** Time scale is a linear scale over epoch ms — named for intent. */
    scaleTime(t0, t1, r0, r1) { return math.scaleLinear(t0, t1, r0, r1); },

    /**
     * Log-compressed scale for count/byte scatters: position is
     * log10(value + 1), so zero sits exactly at the origin and every
     * decade costs the same distance. Domain is [0, max]; from() inverts
     * the mapping for hit-testing.
     */
    scaleLog(max, r0, r1) {
      const L = (v) => Math.log10(Math.max(0, v) + 1);
      const top = L(max) || 1;
      return {
        to: (v) => r0 + (L(v) / top) * (r1 - r0),
        from: (px) => Math.pow(10, ((px - r0) / ((r1 - r0) || 1)) * top) - 1,
      };
    },

    /**
     * Ticks for that log axis over [0, max]: 0, the powers of `base` that
     * fall INSIDE the data, then max itself as the top label. Decades are
     * skipped evenly when they outnumber `count`.
     *
     * The axis never rounds up to the next full power. It used to, and on a
     * base-1024 byte axis that costs a whole decade: a 17 GB largest app
     * produced a "1.0 TB" ceiling with a third of the plot permanently empty,
     * and the number at the top belonged to nothing in the data. The top of
     * an axis is a claim about the data, so it states the data.
     */
    logTicks(max, base = 10, count = 5) {
      if (!(max > 0) || !(base > 1)) return [0, 1];
      // the 1e-9 keeps an exact power from flooring into the decade below it
      const topExp = Math.floor(Math.log(max) / Math.log(base) + 1e-9);
      // one slot of the budget belongs to the max label
      const step = Math.max(1, Math.ceil(topExp / Math.max(1, count - 1)));
      const out = [];
      for (let e = topExp; e > 0; e -= step) out.push(Math.pow(base, e));
      out.reverse();
      // Distance is measured in the scale's own log10(v+1) space, so "far
      // enough apart to read" means the same fraction of the plot at any
      // base: a decade closer than 8% of the axis to max gives up its place
      // rather than printing its label on top of the max's.
      const L = (v) => Math.log10(v + 1);
      const span = L(max) || 1;
      if (!out.length || L(max) - L(out[out.length - 1]) > span * 0.08) out.push(max);
      else out[out.length - 1] = max;
      return [0, ...out];
    },

    /** 999 → '999', 10000 → '10k', 1200000 → '1.2M' — log-axis count labels. */
    compactCount(v) {
      if (!Number.isFinite(v) || v <= 0) return '0';
      const t = (n) => String(Math.round(n * 10) / 10);
      return v >= 1e6 ? t(v / 1e6) + 'M' : v >= 1000 ? t(v / 1000) + 'k' : t(v);
    },

    /**
     * Dot shrink under crowding: full size through 40 points, then a
     * linear ease down to a 0.6× floor at 300 — a ~300-app scatter reads
     * as points, not one blob. Monotone; never below the floor.
     */
    densityScale(n) {
      if (!(n > 40)) return 1;
      return 1 - 0.4 * Math.min(1, (n - 40) / 260);
    },

    /** 1/2/5 × 10^k step rounding (the classic nice-number algorithm). */
    niceNum(range, round) {
      if (!(range > 0)) return 1;
      const exp = Math.floor(Math.log10(range));
      const f = range / Math.pow(10, exp);
      let nf;
      if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
      else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
      return nf * Math.pow(10, exp);
    },

    /**
     * Nice ticks covering [min, max]: first tick ≤ min, last tick ≥ max,
     * step is always 1, 2 or 5 × 10^k. Returns ascending values.
     */
    niceTicks(min, max, count = 4) {
      if (!Number.isFinite(min)) min = 0;
      if (!Number.isFinite(max)) max = 1;
      if (max < min) { const t = min; min = max; max = t; }
      if (max === min) max = min === 0 ? 1 : min + Math.abs(min) * 0.1;
      const step = math.niceNum(math.niceNum(max - min, false) / Math.max(1, count), true);
      const lo = Math.floor(min / step) * step;
      const hi = Math.ceil(max / step) * step;
      const out = [];
      // fp-stable walk: index math, not repeated addition.
      const n = Math.round((hi - lo) / step);
      for (let i = 0; i <= n; i++) out.push(lo + i * step);
      return out;
    },

    /**
     * Monotone cubic smoothing (Fritsch–Carlson). Returns bezier segments
     * [{x0,y0,c1x,c1y,c2x,c2y,x1,y1}] whose chain never overshoots the
     * data: monotone input stays monotone through the curve.
     */
    monotone(xs, ys) {
      const n = xs.length;
      if (n < 2) return [];
      const dx = [], slope = [];
      for (let i = 0; i < n - 1; i++) {
        dx.push(xs[i + 1] - xs[i] || 1e-9);
        slope.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1e-9));
      }
      const m = [slope[0]];
      for (let i = 1; i < n - 1; i++) {
        if (slope[i - 1] * slope[i] <= 0) m.push(0);
        else {
          const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1];
          m.push((w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]));
        }
      }
      m.push(slope[n - 2]);
      // Fritsch–Carlson clamp: keep tangents inside the monotone circle.
      for (let i = 0; i < n - 1; i++) {
        if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
        const a = m[i] / slope[i], b = m[i + 1] / slope[i];
        const s = a * a + b * b;
        if (s > 9) {
          const t = 3 / Math.sqrt(s);
          m[i] = t * a * slope[i];
          m[i + 1] = t * b * slope[i];
        }
      }
      const segs = [];
      for (let i = 0; i < n - 1; i++) {
        const h = dx[i] / 3;
        segs.push({
          x0: xs[i], y0: ys[i],
          c1x: xs[i] + h, c1y: ys[i] + m[i] * h,
          c2x: xs[i + 1] - h, c2y: ys[i + 1] - m[i + 1] * h,
          x1: xs[i + 1], y1: ys[i + 1],
        });
      }
      return segs;
    },

    /** Evaluate one cubic bezier segment at t ∈ [0,1] — used by tests. */
    bezierPoint(seg, t) {
      const u = 1 - t;
      return {
        x: u * u * u * seg.x0 + 3 * u * u * t * seg.c1x + 3 * u * t * t * seg.c2x + t * t * t * seg.x1,
        y: u * u * u * seg.y0 + 3 * u * u * t * seg.c1y + 3 * u * t * t * seg.c2y + t * t * t * seg.y1,
      };
    },

    /** #RRGGBB → [r,g,b]. */
    hexRgb(hex) {
      const h = hex.replace('#', '');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    },

    /** [r,g,b] → #RRGGBB (uppercase, stable for tests). */
    rgbHex(r, g, b) {
      const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
      return ('#' + c(r) + c(g) + c(b)).toUpperCase();
    },

    /** Linear interpolation between two hex colors. */
    lerpColor(a, b, t) {
      const A = math.hexRgb(a), B = math.hexRgb(b);
      return math.rgbHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
    },

    /**
     * The same color at alpha `a` — for gradient fade stops. Theme tokens
     * arrive as #RRGGBB or rgb()/rgba(); anything else (a named color, a
     * var() indirection) falls back to fully transparent rather than
     * interpolating through a wrong hue.
     */
    alpha(color, a) {
      const c = String(color).trim();
      if (/^#[0-9a-f]{6}$/i.test(c)) {
        const [r, g, b] = math.hexRgb(c);
        return `rgba(${r},${g},${b},${a})`;
      }
      const m = c.match(/^rgba?\(([^)]+)\)$/i);
      if (m) {
        const p = m[1].split(',').map((x) => x.trim());
        if (p.length >= 3) return `rgba(${p[0]},${p[1]},${p[2]},${a})`;
      }
      return 'rgba(0,0,0,0)';
    },

    /**
     * n colors sampled across the blue ramp. Endpoints are exact anchors:
     * ramp(n)[0] is #0A84FF and ramp(n)[n-1] is #B9DBFF for n ≥ 2.
     * Beyond 8 the muted slates repeat — restraint over rainbow.
     */
    ramp(n, stops = FX_RAMP_CORE) {
      if (!Number.isInteger(n) || n <= 0) return [];
      if (n === 1) return [stops[0].toUpperCase()];
      const out = [];
      const core = Math.min(n, 4);
      for (let i = 0; i < core; i++) {
        const t = (i / (core - 1)) * (stops.length - 1);
        const lo = Math.floor(t), hi = Math.min(stops.length - 1, lo + 1);
        out.push(math.lerpColor(stops[lo], stops[hi], t - lo).toUpperCase());
      }
      for (let i = 4; i < n; i++) out.push(FX_RAMP_MUTED[(i - 4) % FX_RAMP_MUTED.length]);
      return out;
    },

    /**
     * Ring/donut arc layout. Distributes 2π across `values` with a fixed
     * gap between segments; spans + gaps sum to exactly 2π. Zero-value
     * items get a zero span (and their gap collapses with them).
     */
    arcLayout(values, opts = {}) {
      const { startAngle = -Math.PI / 2, gap = 0.028 } = opts;
      const total = values.reduce((s, v) => s + Math.max(0, v), 0);
      const live = values.filter((v) => v > 0).length;
      const gapAll = live > 1 ? gap * live : 0;
      const sweep = Math.PI * 2 - gapAll;
      let a = startAngle;
      const segs = [];
      for (const v of values) {
        const frac = total > 0 ? Math.max(0, v) / total : 0;
        const span = frac * sweep;
        segs.push({ start: a, end: a + span, frac });
        a += span + (v > 0 && live > 1 ? gap : 0);
      }
      return segs;
    },

    /** Point on a circle. */
    polar(cx, cy, r, a) { return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }; },

    /** Least-squares line for the projection series. */
    linreg(points) {
      const n = points.length;
      if (n < 2) {
        const y = n ? points[0].y : 0;
        return { slope: 0, intercept: y, project: () => y };
      }
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
      const den = n * sxx - sx * sx;
      const slope = den ? (n * sxy - sx * sy) / den : 0;
      const intercept = (sy - slope * sx) / n;
      return { slope, intercept, project: (x) => slope * x + intercept };
    },

    /** [min, max] of a numeric array, ignoring non-finite values. */
    extent(values) {
      let lo = Infinity, hi = -Infinity;
      for (const v of values) {
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (lo === Infinity) { lo = 0; hi = 1; }
      return [lo, hi];
    },

    /** ease-out cubic — the draw-in curve everywhere in this kit. */
    easeOut(t) { return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3); },

    /**
     * bklit's master easing — cubic-bezier(0.85, 0, 0.15, 1) — solved
     * numerically: bisection on the x polynomial, then the y polynomial.
     * The control points are point-symmetric about (0.5, 0.5), so
     * easeMaster(0.5) is exactly 0.5.
     */
    easeMaster(t) {
      t = Math.min(1, Math.max(0, t));
      if (t === 0 || t === 1) return t;
      const bez = (a, b, u) => 3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u;
      let lo = 0, hi = 1;
      for (let i = 0; i < 26; i++) {
        if (bez(0.85, 0.15, (lo + hi) / 2) < t) lo = (lo + hi) / 2; else hi = (lo + hi) / 2;
      }
      return bez(0, 1, (lo + hi) / 2);
    },

    /**
     * One color at t ∈ [0,1] along the ramp stops (accent → ice by
     * default) — the continuous interpolation the discrete ramp() samples.
     * Non-finite t reads as 0 rather than producing a broken hex.
     */
    sampleRamp(t, stops = FX_RAMP_CORE) {
      t = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
      if (stops.length === 1) return stops[0].toUpperCase();
      const x = t * (stops.length - 1);
      const lo = Math.min(stops.length - 2, Math.floor(x));
      return math.lerpColor(stops[lo], stops[lo + 1], x - lo).toUpperCase();
    },

    /**
     * Sign runs for the profit/loss line. Each run is { sign: 1|-1|0,
     * points } — a crossing segment is cut at the EXACT interpolated x
     * where y = 0, and that boundary point belongs to BOTH runs so the
     * strokes meet with no gap. A stretch that sits on zero is its own
     * sign-0 run; a lone endpoint on the axis stays with the live side.
     */
    zeroSplit(points) {
      const pts = (points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
      if (!pts.length) return [];
      const sgn = (y) => (y > 0 ? 1 : y < 0 ? -1 : 0);
      const runs = [];
      let cur = { sign: sgn(pts[0].y), points: [pts[0]] };
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if (a.y * b.y < 0) {
          const t = a.y / (a.y - b.y);
          const zero = { x: a.x + (b.x - a.x) * t, y: 0 };
          cur.points.push(zero);
          runs.push(cur);
          cur = { sign: sgn(b.y), points: [zero, b] };
          continue;
        }
        const segSign = sgn(a.y + b.y); // one endpoint on the axis keeps the live sign
        if (segSign !== cur.sign) {
          if (cur.points.length > 1) { runs.push(cur); cur = { sign: segSign, points: [a] }; }
          else cur.sign = segSign; // a single-point run adopts its first segment's sign
        }
        cur.points.push(b);
      }
      runs.push(cur);
      return runs;
    },

    /**
     * Funnel geometry: every stage sized against the FIRST stage — the
     * conversion reading. frac drives the segment size (clamped so a
     * stage larger than its source cannot burst the track), pct stays
     * unclamped because the number must not lie. A zero or missing first
     * stage yields honest zeros, never NaN.
     */
    funnelLayout(values) {
      const vals = (values || []).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
      const first = vals[0] || 0;
      return vals.map((v) => ({
        frac: first > 0 ? Math.min(1, v / first) : 0,
        pct: first > 0 ? (v / first) * 100 : 0,
      }));
    },

    /**
     * How many of `rows` discrete squares light for value/max. Zero stays
     * dark; any real value lights at least one square; the max fills the
     * column exactly — rounding never over- or under-shoots the ends.
     */
    squareStack(value, max, rows) {
      if (!(rows > 0) || !(max > 0) || !(value > 0)) return 0;
      return Math.max(1, Math.min(rows, Math.round((value / max) * rows)));
    },

    /**
     * Order + clamp a brush window into [lo, hi], preserving a minimum
     * span. The span is kept by SLIDING against an edge, never by
     * inverting: a window dragged past the domain compresses only down to
     * minSpan, and a window wider than the domain becomes the domain.
     */
    clampBrush(a, b, lo, hi, minSpan = 0) {
      let x0 = Math.min(a, b), x1 = Math.max(a, b);
      const span = Math.max(0, minSpan);
      if (x1 - x0 < span) { const c = (x0 + x1) / 2; x0 = c - span / 2; x1 = c + span / 2; }
      if (x0 < lo) { x1 += lo - x0; x0 = lo; }
      if (x1 > hi) { x0 -= x1 - hi; x1 = hi; }
      return [Math.max(lo, x0), Math.min(hi, x1)];
    },

    /** A brush window may never shrink below this share of the domain. */
    BRUSH_MIN_FRAC: 0.02,

    /**
     * The zoom window a pointer at canvas x produces, in TIME.
     *
     * Pixels invert through the FULL domain (XFull), never the zoomed one:
     * once a window is set, X maps only the visible slice, so inverting a
     * strip pixel through it runs the handle away from the pointer.
     *
     * 'mid' TRANSLATES the grabbed window by the pointer's travel and keeps
     * its span (dragging the middle must not stretch an edge); any other
     * mode drags one edge away from the anchor, and a press that never
     * moves still yields BRUSH_MIN_FRAC of the domain rather than
     * collapsing the window to nothing.
     */
    brushDrag(drag, x, f, m) {
      const t = m.XFull.from(Math.max(f.padL, Math.min(f.width - f.padR, x)));
      if (drag.mode === 'mid') {
        const d = t - drag.grabT;
        const span = drag.cur[1] - drag.cur[0];
        return math.clampBrush(drag.cur[0] + d, drag.cur[1] + d, m.t0, m.t1, span);
      }
      return math.clampBrush(drag.anchor, t, m.t0, m.t1, (m.t1 - m.t0) * math.BRUSH_MIN_FRAC);
    },

    /**
     * up | down | flat for a live series: the newest third against the
     * oldest third, read relative to the series' own level so a busy
     * stream and a quiet one share one yardstick. Fewer than 4 samples is
     * an honest 'flat' — two points are not a trend.
     */
    /* ── radar geometry ──────────────────────────────────────────────────
       Axis 0 points straight up and the rest run clockwise, so the same
       inputs always draw the same shape and two files can be compared by
       silhouette alone. */
    radarAngle(i, n) { return -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2; },

    /**
     * The vertex for axis `i` at value `v` (0–1), or NULL when that signal
     * did not answer.
     *
     * The reclaim score's promise is that a missing signal is left out, never
     * counted as zero — and on a radar those two look identical if a null is
     * allowed to land at the centre. So only a real number gets a vertex; a
     * measured 0 still gets one, at the centre, because that is a fact.
     */
    radarPoint(cx, cy, R, i, n, v) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      const a = this.radarAngle(i, n);
      const r = R * Math.max(0, Math.min(1, v));
      return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
    },

    /**
     * The outline as RUNS of consecutive answered axes.
     *
     * A gap must stay a gap: joining the neighbours either side of a missing
     * axis draws a chord straight past it, which reads as a measured value
     * halfway between them. Runs wrap around the end, so a single gap yields
     * one open run rather than two touching ones; all-answered yields one
     * closed polygon.
     */
    radarRuns(values) {
      const n = values.length;
      const ok = values.map((v) => typeof v === 'number' && Number.isFinite(v));
      const count = ok.filter(Boolean).length;
      if (count === 0) return [];
      if (count === n) return [{ start: 0, len: n, closed: true }];
      const runs = [];
      for (let i = 0; i < n; i++) {
        // a run starts where an answered axis follows an unanswered one
        if (!ok[i] || ok[(i - 1 + n) % n]) continue;
        let len = 0;
        while (len < n && ok[(i + len) % n]) len++;
        runs.push({ start: i, len, closed: false });
      }
      return runs;
    },

    /** The axis a pointer is nearest, or -1 outside the grid or at the centre. */
    radarHit(cx, cy, R, n, x, y) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > R * 1.28 || dist < R * 0.06) return -1;
      let a = Math.atan2(dy, dx) + Math.PI / 2;          // 0 at twelve o'clock
      a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      return Math.round(a / ((Math.PI * 2) / n)) % n;
    },

    momentum(values, threshold = 0.12) {
      const vs = (values || []).filter((v) => Number.isFinite(v));
      if (vs.length < 4) return 'flat';
      const k = Math.max(1, Math.floor(vs.length / 3));
      const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
      const head = mean(vs.slice(0, k)), tail = mean(vs.slice(-k));
      const scale = Math.max(Math.abs(head), Math.abs(tail), 1e-9);
      const d = (tail - head) / scale;
      return d > threshold ? 'up' : d < -threshold ? 'down' : 'flat';
    },
  };

  /* ═════════════════════ shared DOM plumbing ═════════════════════ */

  const fmtBytes = (v) => formatBytes(v); // the app's ONE byte ladder
  const tone = (name, fallback) => (cssVar(name) || fallback);

  const FX_DATE = { fmt: null };
  function fxDate(ms) {
    if (!FX_DATE.fmt) FX_DATE.fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    return FX_DATE.fmt.format(ms);
  }

  /** Container that can host an absolutely-positioned tooltip. */
  function anchor(el) {
    const host = el.parentElement || el;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    return host;
  }

  /** Floating tooltip inside the chart container. All text via textContent. */
  function makeTip(host) {
    const tip = document.createElement('div');
    tip.className = 'fx-tip';
    tip.setAttribute('aria-hidden', 'true');
    host.appendChild(tip);
    /* bklit's panel trails the crosshair on a critically-damped ease (the
       "damping 20" feel) instead of teleporting. The follow loop runs only
       while the gap is still closing — it parks itself the frame the panel
       settles, so a resting hover costs zero rAF. REDUCED and hidden snap. */
    let cur = null, goal = null, followRaf = 0, lastTs = 0;
    const apply = () => { tip.style.transform = `translate(${Math.round(cur.x)}px, ${Math.round(cur.y)}px)`; };
    function settle(ts) {
      followRaf = 0;
      if (!goal || !cur) return;
      if (document.hidden) { cur = { ...goal }; apply(); return; }
      const dt = lastTs ? Math.min(64, ts - lastTs) : 16;
      lastTs = ts;
      const k = 1 - Math.exp(-dt / 70);
      cur.x += (goal.x - cur.x) * k;
      cur.y += (goal.y - cur.y) * k;
      if (Math.abs(goal.x - cur.x) < 0.4 && Math.abs(goal.y - cur.y) < 0.4) { cur = { ...goal }; apply(); return; }
      apply();
      followRaf = requestAnimationFrame(settle);
    }
    function moveTo(x, y) {
      goal = { x, y };
      if (REDUCED || !cur) { cur = { x, y }; apply(); return; }
      if (!followRaf) { lastTs = 0; followRaf = requestAnimationFrame(settle); }
    }
    /* The panel's content, as one string. A hover coalesced at 60fps lands
       on the same sample for most frames; rebuilding an identical panel
       would dirty the tree every frame and force a layout to re-measure a
       box that cannot have changed. */
    let sig = null, tw = 0, th = 0;
    /* Escapes, not raw bytes: the page ships as HTML, and the parser replaces
       a literal U+0000 in script data with U+FFFD — the running string would
       not be the declared one. It also makes the artifact binary to grep. */
    const signature = (title, rows) =>
      title + '\u0000' + rows.map((r) => (r.color || '') + '\u0001' + r.name + '\u0001' + r.value).join('\u0002');
    return {
      el: tip,
      /** rows: [{color?, name, value}], title: string */
      show(title, rows, x, y) {
        const next = signature(title, rows);
        if (next !== sig) {
          sig = next;
          tip.textContent = '';
          if (title) {
            const t = document.createElement('div');
            t.className = 'fx-tip-title fx-num';
            t.textContent = title;
            tip.appendChild(t);
          }
          for (const r of rows) {
            const row = document.createElement('div');
            row.className = 'fx-tip-row';
            if (r.color) {
              const dot = document.createElement('span');
              dot.className = 'fx-dot';
              dot.style.background = r.color;
              row.appendChild(dot);
            }
            const nm = document.createElement('span');
            nm.className = 'fx-tip-name';
            nm.textContent = r.name;
            const val = document.createElement('span');
            val.className = 'fx-tip-val fx-num';
            val.textContent = r.value;
            row.appendChild(nm); row.appendChild(val);
            tip.appendChild(row);
          }
          tip.classList.add('on');
          tw = tip.offsetWidth; th = tip.offsetHeight;
        } else {
          tip.classList.add('on');
        }
        const hw = host.clientWidth;
        let lx = x + 14, ly = y - th - 12;
        if (lx + tw > hw - 6) lx = x - tw - 14;
        if (lx < 6) lx = 6;
        if (ly < 6) ly = y + 16;
        moveTo(lx, ly);
      },
      hide() { tip.classList.remove('on'); cur = null; goal = null; },
      destroy() { if (followRaf) cancelAnimationFrame(followRaf); tip.remove(); },
    };
  }

  /**
   * Lifecycle shared by every chart: one ResizeObserver that sleeps when
   * the size hasn't actually changed, a visibility guard so nothing draws
   * while document.hidden, and a registry of listeners for destroy().
   */
  function makeLife(watchEl, onResize) {
    const life = {
      dead: false,
      raf: 0,
      lastW: 0,
      lastH: 0,
      unlisteners: [],
      on(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        life.unlisteners.push(() => target.removeEventListener(type, fn, opts));
      },
      stopRaf() { if (life.raf) { cancelAnimationFrame(life.raf); life.raf = 0; } },
      destroy() {
        life.dead = true;
        life.stopRaf();
        if (life.ro) life.ro.disconnect();
        for (const off of life.unlisteners) off();
        life.unlisteners.length = 0;
      },
    };
    if (typeof ResizeObserver !== 'undefined' && watchEl) {
      life.ro = new ResizeObserver((entries) => {
        if (life.dead || document.hidden) return;
        const box = entries[entries.length - 1].contentRect;
        const w = Math.round(box.width), h = Math.round(box.height);
        if (w === life.lastW && h === life.lastH) return; // sleeping when unchanged
        life.lastW = w; life.lastH = h;
        onResize(w, h);
      });
      life.ro.observe(watchEl);
    }
    // Redraw once when the tab becomes visible again (frames were skipped).
    life.on(document, 'visibilitychange', () => {
      if (!document.hidden && !life.dead) onResize(life.lastW, life.lastH);
    });
    return life;
  }

  /** REDUCED-aware progress animation: instant under reduced motion.
      The handle is cleared BEFORE the final step so a completion callback
      may chain a follow-up animation without its rAF being orphaned. */
  function animate(life, dur, step, ease = math.easeOut) {
    if (REDUCED || document.hidden) { step(1); return; }
    const t0 = performance.now();
    const tick = (t) => {
      if (life.dead) return;
      if (document.hidden) { life.raf = 0; step(1); return; } // nothing runs while hidden
      const p = Math.min(1, (t - t0) / dur);
      if (p < 1) { step(ease(p)); life.raf = requestAnimationFrame(tick); }
      else { life.raf = 0; step(1); }
    };
    life.raf = requestAnimationFrame(tick);
  }

  /** Dotted 1px horizontal gridline — the bklit signature. */
  function dottedLine(ctx, x0, x1, y, color) {
    ctx.save();
    ctx.setLineDash([1, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(y) + 0.5);
    ctx.lineTo(x1, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  function traceSegs(ctx, segs) {
    if (!segs.length) return;
    ctx.moveTo(segs[0].x0, segs[0].y0);
    for (const s of segs) ctx.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x1, s.y1);
  }

  /* ═════════════════════ area(canvas, spec) ═════════════════════
     spec: {
       series: [{ name, points: [{t, v}], color? }],   // t = ms, v = bytes
       projection?: { name?, points: [{t, v}] },        // dashed forecast
       height?: 300, yTickCount?: 4,
       formatValue?: fmtBytes, formatTime?: fxDate,
       fadeEdges?: false,                    // series dissolve in the outer 10%
       pattern?: 'dots'|'diagonal'|'cross',  // plot backdrop, fades in after the reveal
       highlightRows?: [v],                  // solid emphasized gridlines at these values
       referenceBand?: { from, to, label? }, // dashed-edged tinted y-band
       brush?: { height?: 72 },              // mini x-zoom strip below the plot
     } */
  function area(canvas, spec) {
    const host = anchor(canvas);
    const tip = makeTip(host);
    /* bklit's date pill: pinned to the crosshair on the axis line, shown
       only when formatTime yields a date — the panel then drops its title
       so the date is stated once. Its digits roll via FxNum, so scrubbing
       across days reads like a slot machine. */
    const pill = document.createElement('div');
    pill.className = 'fx-tip-pill fx-num';
    host.appendChild(pill);
    let pillTxt = null, pillW = 0; // measured once per text, not per frame
    let s = spec, progress = REDUCED ? 1 : 0, hoverT = null;
    let patternAlpha = REDUCED ? 1 : 0; // the backdrop lands after the series reveal
    let yShown = null;    // the tweened y-domain top — updates morph it, never re-sweep
    let win = null;       // brush selection [t0, t1] in data time; null = everything
    let drag = null;      // a live brush gesture
    let brushPx = null;   // last-painted brush geometry, for hit-testing
    let fadeLayer = null; // offscreen pass so fadeEdges erases only the series
    let patTile = null;   // cached pattern tile, keyed by look
    const BRUSH_GAP = 8;
    const life = makeLife(host, () => render());

    function frame() {
      const w = Math.max(280, host.clientWidth || 280);
      const plotH = s.height || 300;
      const brushH = s.brush ? Math.max(40, s.brush.height || 72) : 0;
      const h = plotH + (brushH ? brushH + BRUSH_GAP : 0);
      return { ...Canvas2D.setup(canvas, w, h), padL: 62, padR: 14, padT: 14, padB: 26,
               plotH, brushH, brushTop: brushH ? plotH + BRUSH_GAP : 0 };
    }

    function model(f) {
      const fmtV = s.formatValue || fmtBytes;
      const fmtT = s.formatTime || fxDate;
      const series = (s.series || []).filter((sr) => sr.points && sr.points.length);
      const proj = s.projection && s.projection.points && s.projection.points.length > 1 ? s.projection : null;
      const allT = [], allV = [];
      for (const sr of series) for (const p of sr.points) { allT.push(p.t); allV.push(p.v); }
      if (proj) for (const p of proj.points) { allT.push(p.t); allV.push(p.v); }
      const [t0, t1] = math.extent(allT);
      const [, fullMax] = math.extent(allV);
      // the view domain: the brush window when one is set, everything otherwise
      let v0 = t0, v1 = t1;
      if (win && t1 > t0) {
        const c = math.clampBrush(win[0], win[1], t0, t1, (t1 - t0) * math.BRUSH_MIN_FRAC);
        v0 = c[0]; v1 = c[1];
      }
      // y fits what the window shows — that is what the zoom means
      let vMax = 0;
      for (const sr of series) for (const p of sr.points) if (p.t >= v0 && p.t <= v1 && p.v > vMax) vMax = p.v;
      if (proj && !win) for (const p of proj.points) if (p.v > vMax) vMax = p.v;
      if (!(vMax > 0)) vMax = fullMax;
      // A reference band names a real threshold (a budget); the axis has to
      // reach any finite bound or the band silently falls above the fold.
      // An open-ended bound (Infinity) rides the data's own domain.
      if (s.referenceBand && !win) {
        for (const bv of [s.referenceBand.from, s.referenceBand.to]) {
          if (Number.isFinite(bv) && bv > vMax) vMax = bv;
        }
      }
      const ticks = math.niceTicks(0, vMax * 1.05 || 1, s.yTickCount || 4);
      const targetTop = ticks[ticks.length - 1];
      if (yShown == null) yShown = targetTop;
      const X = math.scaleTime(v0, v1, f.padL, f.width - f.padR);
      const XFull = math.scaleTime(t0, t1, f.padL, f.width - f.padR);
      return { series, proj, ticks, targetTop, X, XFull, Y: yScale(f), t0, t1, v0, v1, fullMax, fmtV, fmtT };
    }

    /* The y scale is the one part of the model that reads the tweened top,
       so a caller that nudges yShown can re-derive it instead of rebuilding
       the whole model — one definition, both readers. */
    function yScale(f) { return math.scaleLinear(0, yShown, f.plotH - f.padB, f.padT); }

    /* The backdrop pattern paints FIRST, alone on the cleared canvas, so
       its 10% edge fades can erase (destination-out) without touching the
       grid or the series that land above it. */
    function drawPattern(ctx, f, gridColor) {
      const key = s.pattern + '|' + gridColor;
      if (!patTile || patTile.key !== key) {
        const t = document.createElement('canvas');
        t.width = 8; t.height = 8;
        const tc = t.getContext('2d');
        tc.strokeStyle = gridColor; tc.fillStyle = gridColor; tc.lineWidth = 1;
        if (s.pattern === 'dots') { tc.beginPath(); tc.arc(4, 4, 1, 0, Math.PI * 2); tc.fill(); }
        else if (s.pattern === 'cross') { tc.beginPath(); tc.moveTo(0, 7.5); tc.lineTo(8, 7.5); tc.moveTo(7.5, 0); tc.lineTo(7.5, 8); tc.stroke(); }
        else { tc.beginPath(); tc.moveTo(-2, 10); tc.lineTo(10, -2); tc.stroke(); } // diagonal
        patTile = { key, pattern: ctx.createPattern(t, 'repeat') };
      }
      const x0 = f.padL, x1 = f.width - f.padR, y0 = f.padT, y1 = f.plotH - f.padB;
      const zx = (x1 - x0) * 0.10, zy = (y1 - y0) * 0.10;
      ctx.save();
      ctx.globalAlpha = 0.5 * patternAlpha;
      ctx.fillStyle = patTile.pattern;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-out';
      let g = ctx.createLinearGradient(x0, 0, x0 + zx, 0);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(x0, y0, zx, y1 - y0);
      g = ctx.createLinearGradient(x1 - zx, 0, x1, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = g; ctx.fillRect(x1 - zx, y0, zx, y1 - y0);
      g = ctx.createLinearGradient(0, y0, 0, y0 + zy);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(x0, y0, x1 - x0, zy);
      g = ctx.createLinearGradient(0, y1 - zy, 0, y1);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = g; ctx.fillRect(x0, y1 - zy, x1 - x0, zy);
      ctx.restore();
    }

    /* Reference band: tinted rect, dashed 4,4 edges, inward brackets at
       the horizontal centre. Its y-tick labels tint in the tick loop. */
    function drawBand(ctx, f, m, accent) {
      const b = s.referenceBand;
      const lo = Math.min(b.from, b.to), hi = Math.max(b.from, b.to);
      const top = f.padT, bot = f.plotH - f.padB;
      const yT = Math.max(top, Math.min(bot, m.Y.to(hi)));
      const yB = Math.max(top, Math.min(bot, m.Y.to(lo)));
      if (yB - yT < 1) return;
      const x0 = f.padL, x1 = f.width - f.padR;
      ctx.save();
      ctx.fillStyle = math.alpha(accent, 0.06);
      ctx.fillRect(x0, yT, x1 - x0, yB - yT);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = math.alpha(accent, 0.4);
      ctx.lineWidth = 1;
      for (const y of [yT, yB]) {
        ctx.beginPath();
        ctx.moveTo(x0, Math.round(y) + 0.5);
        ctx.lineTo(x1, Math.round(y) + 0.5);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = math.alpha(accent, 0.7);
      ctx.lineWidth = 1.5;
      const cx = (x0 + x1) / 2;
      for (const [y, dir] of [[yT, 1], [yB, -1]]) {
        ctx.beginPath();
        ctx.moveTo(cx - 7, y + dir * 5);
        ctx.lineTo(cx - 7, y + dir * 1);
        ctx.lineTo(cx + 7, y + dir * 1);
        ctx.lineTo(cx + 7, y + dir * 5);
        ctx.stroke();
      }
      if (b.label) {
        ctx.fillStyle = math.alpha(accent, 0.85);
        ctx.font = '600 10px -apple-system, "SF Pro Text", sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(b.label, x1 - 6, Math.min(bot - 4, yT + 12));
      }
      ctx.restore();
    }

    /* One pass of the series ink — shared by the direct path and the
       fadeEdges offscreen path. */
    function seriesPass(ctx, f, m) {
      const colors = math.ramp(Math.max(2, m.series.length));
      const baseY = m.Y.to(0);
      m.series.forEach((sr, i) => {
        const col = sr.color || colors[i];
        const xs = sr.points.map((p) => m.X.to(p.t));
        const ys = sr.points.map((p) => m.Y.to(p.v));
        const segs = math.monotone(xs, ys);
        if (!segs.length) {
          /* A first-ever snapshot IS data: monotone() needs two points, so
             a 1-point series used to render a bare grid that read as "no
             data" while the hover tooltip contradicted it. Draw the sample
             as the same filled dot the hover path draws. */
          if (sr.points.length === 1) {
            ctx.beginPath();
            ctx.arc(xs[0], ys[0], 3.5, 0, Math.PI * 2);
            ctx.fillStyle = col;
            ctx.fill();
          }
          return;
        }
        const rgb = math.hexRgb(col);
        const grad = ctx.createLinearGradient(0, f.padT, 0, baseY);
        grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.28)`);
        grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
        ctx.beginPath();
        traceSegs(ctx, segs);
        ctx.lineTo(xs[xs.length - 1], baseY);
        ctx.lineTo(xs[0], baseY);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.beginPath();
        traceSegs(ctx, segs);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.stroke();
      });
    }

    function drawSeries(ctx, f, m) {
      // draw-in: clip sweep left → right (REDUCED renders complete); the
      // same clip keeps a brushed zoom inside the plot box
      const sweepX = f.padL + (f.width - f.padL - f.padR) * progress + 2;
      const clipX0 = f.padL - 1;
      const clipW = Math.max(0, Math.min(sweepX, f.width - f.padR + 1) - clipX0);
      const clipY0 = f.padT - 6;
      const clipH = (f.plotH - f.padB) - f.padT + 12;
      let target = ctx;
      if (s.fadeEdges) {
        if (!fadeLayer) fadeLayer = document.createElement('canvas');
        const lf = Canvas2D.setup(fadeLayer, f.width, f.height);
        lf.ctx.clearRect(0, 0, f.width, f.height);
        target = lf.ctx;
      }
      target.save();
      target.beginPath();
      target.rect(clipX0, clipY0, clipW, clipH);
      target.clip();
      seriesPass(target, f, m);
      target.restore();
      if (s.fadeEdges) {
        const zone = (f.width - f.padL - f.padR) * 0.10;
        target.save();
        target.globalCompositeOperation = 'destination-out';
        let g = target.createLinearGradient(f.padL, 0, f.padL + zone, 0);
        g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        target.fillStyle = g;
        target.fillRect(f.padL - 1, 0, zone + 1, f.plotH);
        g = target.createLinearGradient(f.width - f.padR - zone, 0, f.width - f.padR, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
        target.fillStyle = g;
        target.fillRect(f.width - f.padR - zone, 0, zone + 1, f.plotH);
        target.restore();
        ctx.drawImage(fadeLayer, 0, 0, f.width, f.height);
      }
    }

    /* Projection: dashed 4,4 with a gradient stroke that dissolves into
       the future, and a terminal hollow ring that lands after the reveal. */
    function drawProjection(ctx, f, m, accent) {
      const xs = m.proj.points.map((p) => m.X.to(p.t));
      const ys = m.proj.points.map((p) => m.Y.to(p.v));
      const sweepX = f.padL + (f.width - f.padL - f.padR) * progress + 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(f.padL - 1, f.padT - 6, Math.max(0, Math.min(sweepX, f.width - f.padR + 1) - (f.padL - 1)),
               (f.plotH - f.padB) - f.padT + 12);
      ctx.clip();
      const g = ctx.createLinearGradient(xs[0], 0, xs[xs.length - 1] > xs[0] ? xs[xs.length - 1] : xs[0] + 1, 0);
      g.addColorStop(0, math.alpha(accent, 0.6));
      g.addColorStop(1, math.alpha(accent, 0.18));
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      traceSegs(ctx, math.monotone(xs, ys));
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      if (progress >= 1) {
        const lx = xs[xs.length - 1], ly = ys[ys.length - 1];
        if (lx >= f.padL && lx <= f.width - f.padR + 1 && ly >= 0 && ly <= f.plotH) {
          ctx.beginPath();
          ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = tone('--bg-1', '#0e0e13');
          ctx.fill();
          ctx.strokeStyle = accent;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }

    /* The brush strip: the whole domain in miniature. Idle — no window, or
       a window spanning everything — reads as "everything selected": the
       series (and the dashed forecast) sharp behind the hairline frame,
       quiet handles resting at both ends, nothing dimmed because nothing
       is excluded. Only a real sub-range dims + blurs the regions outside
       it and raises the accent window. */
    function drawBrush(ctx, f, m) {
      const x0 = f.padL, x1 = f.width - f.padR;
      const top = f.brushTop, bh = f.brushH;
      const grid = tone('--hairline', 'rgba(255,255,255,0.12)');
      const accent = tone('--accent', '#0A84FF');
      const wt0 = win ? win[0] : m.t0, wt1 = win ? win[1] : m.t1;
      const idle = !win || (wt0 <= m.t0 && wt1 >= m.t1);
      const wx0 = m.XFull.to(wt0), wx1 = m.XFull.to(wt1);
      ctx.save();
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, top + 0.5, x1 - x0 - 1, bh - 1);
      const mTop = top + 5, mBot = top + bh - 5;
      const Ym = math.scaleLinear(0, m.fullMax || 1, mBot, mTop);
      const colors = math.ramp(Math.max(2, m.series.length));
      const mini = (c) => {
        m.series.forEach((sr, i) => {
          const xs = sr.points.map((p) => m.XFull.to(p.t));
          const ys = sr.points.map((p) => Ym.to(p.v));
          const segs = math.monotone(xs, ys);
          if (!segs.length) return;
          const col = sr.color || colors[i];
          c.beginPath();
          traceSegs(c, segs);
          c.lineTo(xs[xs.length - 1], mBot);
          c.lineTo(xs[0], mBot);
          c.closePath();
          c.fillStyle = math.alpha(col, 0.10);
          c.fill();
          c.beginPath();
          traceSegs(c, segs);
          c.strokeStyle = col;
          c.lineWidth = 1;
          c.stroke();
        });
        // The forecast belongs in the miniature: it is part of the domain
        // the strip claims to show, and a projection reaching weeks past
        // minutes of history would otherwise leave the strip almost empty.
        if (m.proj) {
          const px = m.proj.points.map((p) => m.XFull.to(p.t));
          const py = m.proj.points.map((p) => Ym.to(p.v));
          c.save();
          c.setLineDash([4, 4]);
          c.strokeStyle = math.alpha(accent, 0.55);
          c.lineWidth = 1;
          c.beginPath();
          px.forEach((x, i) => { if (i) c.lineTo(x, py[i]); else c.moveTo(x, py[i]); });
          c.stroke();
          c.restore();
        }
      };
      ctx.beginPath();
      ctx.rect(x0, top, x1 - x0, bh);
      ctx.clip();
      if (idle) {
        mini(ctx); // sharp everywhere: everything is selected
      } else {
        ctx.save();
        if ('filter' in ctx) ctx.filter = 'blur(1.5px)'; // dimmed regions soften
        ctx.globalAlpha = 0.45;
        mini(ctx);
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.rect(wx0, top, Math.max(1, wx1 - wx0), bh);
        ctx.clip();
        mini(ctx);
        ctx.restore();
        ctx.fillStyle = math.alpha(accent, 0.07);
        ctx.fillRect(wx0, top, Math.max(1, wx1 - wx0), bh);
        ctx.strokeStyle = math.alpha(accent, 0.55);
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(wx0) + 0.5, top + 0.5, Math.max(1, Math.round(wx1 - wx0)) - 1, bh - 1);
      }
      ctx.fillStyle = idle ? math.alpha(accent, 0.35) : accent;
      for (const hx of [wx0, wx1]) {
        Canvas2D.roundRect(ctx, hx - 2, top + bh / 2 - 8, 4, 16, 2);
        ctx.fill();
      }
      ctx.restore();
      brushPx = { x0, x1, wx0, wx1, top, h: bh };
    }

    /* Callers that already built the frame/model this tick pass them in
       (the hover path builds them once per rAF); everyone else gets a
       fresh pair — one construction per paint either way. */
    function render(f, m) {
      if (life.dead || document.hidden) return;
      if (!f) f = frame();
      if (!m) m = model(f);
      const { ctx } = f;
      ctx.clearRect(0, 0, f.width, f.height);

      const grid = tone('--hairline', 'rgba(255,255,255,0.12)');
      const lab = tone('--text-3', '#8a8a93');
      const accent = tone('--accent', '#0A84FF');
      const plotBot = f.plotH - f.padB;
      brushPx = null; // repainted below when the strip draws

      if (s.pattern && patternAlpha > 0) drawPattern(ctx, f, grid);

      ctx.font = '10.5px -apple-system, "SF Pro Text", sans-serif';

      const band = s.referenceBand;
      const bandLo = band ? Math.min(band.from, band.to) : 0;
      const bandHi = band ? Math.max(band.from, band.to) : 0;

      // dotted gridlines + muted byte labels (formatBytes ONLY); ticks
      // inside the reference band tint toward the accent
      ctx.textAlign = 'right';
      for (const v of m.ticks) {
        const y = m.Y.to(v);
        if (y < f.padT - 4 || y > plotBot + 4) continue; // a mid-morph tick off the plot
        dottedLine(ctx, f.padL, f.width - f.padR, y, grid);
        ctx.fillStyle = band && v >= bandLo && v <= bandHi ? accent : lab;
        ctx.fillText(v === 0 ? '0 B' : m.fmtV(v), f.padL - 8, y + 3.5);
      }
      // emphasized rows: solid where the dotted grid whispers
      for (const v of s.highlightRows || []) {
        const y = m.Y.to(v);
        if (y < f.padT || y > plotBot) continue;
        ctx.save();
        ctx.strokeStyle = math.alpha(lab, 0.35);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(f.padL, Math.round(y) + 0.5);
        ctx.lineTo(f.width - f.padR, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.restore();
      }
      if (band) drawBand(ctx, f, m, accent);

      ctx.fillStyle = lab;
      ctx.font = '10.5px -apple-system, "SF Pro Text", sans-serif';
      if (!m.series.length) {
        ctx.textAlign = 'center';
        ctx.fillText('No data yet.', f.width / 2, f.plotH / 2);
        return;
      }
      // minimal date axis: view first · view last
      ctx.textAlign = 'center';
      ctx.fillText(m.fmtT(m.v0), f.padL + 24, f.plotH - 8);
      if (m.v1 > m.v0) ctx.fillText(m.fmtT(m.v1), f.width - f.padR - 24, f.plotH - 8);

      drawSeries(ctx, f, m);

      // projection: dashed, no fill, quieter blue — clearly "not yet real"
      if (m.proj) drawProjection(ctx, f, m, accent);

      if (s.brush && f.brushH) drawBrush(ctx, f, m);

      // crosshair + dots on hover — the line fades through its top and
      // bottom 10% (bklit's tooltip crosshair) instead of hitting the
      // plot edges at full strength.
      if (hoverT !== null) {
        const hx = m.X.to(hoverT);
        const chCol = tone('--text-3', '#8a8a93');
        const chGrad = ctx.createLinearGradient(0, f.padT, 0, plotBot);
        chGrad.addColorStop(0, math.alpha(chCol, 0));
        chGrad.addColorStop(0.1, chCol);
        chGrad.addColorStop(0.9, chCol);
        chGrad.addColorStop(1, math.alpha(chCol, 0));
        ctx.save();
        ctx.setLineDash([1, 3]);
        ctx.strokeStyle = chGrad;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(hx) + 0.5, f.padT);
        ctx.lineTo(Math.round(hx) + 0.5, plotBot);
        ctx.stroke();
        ctx.restore();
        const colors2 = math.ramp(Math.max(2, m.series.length));
        m.series.forEach((sr, i) => {
          const p = nearest(sr.points, hoverT);
          if (!p) return;
          ctx.beginPath();
          ctx.arc(m.X.to(p.t), m.Y.to(p.v), 3.5, 0, Math.PI * 2);
          ctx.fillStyle = sr.color || colors2[i];
          ctx.fill();
          ctx.strokeStyle = tone('--bg-1', '#0e0e13');
          ctx.lineWidth = 1.5;
          ctx.stroke();
        });
      }
    }

    function nearest(points, t) {
      let best = null, bd = Infinity;
      for (const p of points) {
        const d = Math.abs(p.t - t);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }

    /* The y-domain morph: new data tweens the shown top toward the new
       nice top over ≈500ms. The entrance sweep is never replayed. */
    function tweenY() {
      const f = frame();
      const m = model(f);
      if (yShown === m.targetTop) { render(f, m); return; }
      const from = yShown;
      if (REDUCED || document.hidden) { yShown = m.targetTop; render(); return; }
      life.stopRaf();
      animate(life, 500, (p) => {
        yShown = from + (m.targetTop - from) * p;
        render();
      });
    }

    function revealPattern() {
      if (!s.pattern || patternAlpha >= 1) return;
      if (REDUCED || document.hidden) { patternAlpha = 1; render(); return; }
      animate(life, 400, (q) => { patternAlpha = q; render(); });
    }

    /* ── brush interaction: press to grab, edges resize, empty strip
       starts a fresh window, double-click resets ── */
    function brushHit(x, y) {
      if (!brushPx || y < brushPx.top || y > brushPx.top + brushPx.h) return null;
      if (Math.abs(x - brushPx.wx0) <= 6) return 'w';
      if (Math.abs(x - brushPx.wx1) <= 6) return 'e';
      if (x > brushPx.wx0 && x < brushPx.wx1) return 'mid';
      if (x >= brushPx.x0 && x <= brushPx.x1) return 'new';
      return null;
    }

    function onDown(e) {
      if (!s.brush || !brushPx) return;
      const { x, y } = Canvas2D.toLocal(canvas, e.clientX, e.clientY);
      const hit = brushHit(x, y);
      if (!hit) return;
      e.preventDefault();
      const f = frame();
      const m = model(f);
      if (!(m.t1 > m.t0)) return;
      const t = m.XFull.from(Math.max(f.padL, Math.min(f.width - f.padR, x)));
      const cur = win ? win.slice() : [m.t0, m.t1];
      // with no window set the full-strip "window" is only a picture: any
      // press inside it starts a fresh selection instead of grabbing it
      if (hit === 'new' || (hit === 'mid' && !win)) drag = { mode: 'e', cur: [t, t], anchor: t, grabT: t };
      else drag = { mode: hit, cur, anchor: hit === 'e' ? cur[0] : cur[1], grabT: t };
    }

    function applyDrag(mv) {
      const f = frame();
      let m = model(f);
      if (!(m.t1 > m.t0)) return;
      const { x } = Canvas2D.toLocal(canvas, mv.x, mv.y);
      win = math.brushDrag(drag, x, f, m);
      // x zooms instantly; y chases per event — event-driven, no idle loop.
      // The window moved, so the model is rebuilt once for the new domain;
      // the y nudge then re-derives only the scale it invalidated, which is
      // what keeps a drag frame at two model builds instead of three.
      m = model(f);
      yShown += (m.targetTop - yShown) * 0.3;
      m.Y = yScale(f);
      render(f, m);
    }

    /* Hover is coalesced to one rAF: raw mousemove outruns the display, and
       every event used to pay for TWO frame+model builds plus a repaint and
       a forced layout — visible crosshair jank on long series. The last
       pointer position wins; the model is built once and handed to render.
       A live brush drag rides the same coalescer and takes precedence. */
    let pendingMove = null;
    let moveRaf = 0;
    function pointerTick() {
      moveRaf = 0;
      const mv = pendingMove;
      if (!mv || life.dead) return;
      if (drag) { applyDrag(mv); return; }
      const f = frame();
      const m = model(f);
      const { x, y } = Canvas2D.toLocal(canvas, mv.x, mv.y);
      // over the brush strip the cursor narrates what a press would do
      if (s.brush && brushPx && y >= brushPx.top) {
        const hit = brushHit(x, y);
        canvas.style.cursor = hit === 'w' || hit === 'e' ? 'ew-resize'
          : hit === 'mid' ? (win ? 'grab' : 'crosshair') : hit === 'new' ? 'crosshair' : '';
        if (hoverT !== null) { hoverT = null; tip.hide(); pill.classList.remove('on'); render(f, m); }
        return;
      }
      canvas.style.cursor = '';
      if (!m.series.length) return;
      const t = m.X.from(Math.max(f.padL, Math.min(f.width - f.padR, x)));
      // snap to the nearest sample time of the first series, inside the view
      const visible = win ? m.series[0].points.filter((pp) => pp.t >= m.v0 && pp.t <= m.v1) : m.series[0].points;
      const p = nearest(visible.length ? visible : m.series[0].points, t);
      hoverT = p ? p.t : null;
      render(f, m);
      if (p) {
        const rowColors = math.ramp(Math.max(2, m.series.length)); // once, not per series
        const rows = m.series.map((sr, i) => {
          const q = nearest(sr.points, hoverT);
          return { color: sr.color || rowColors[i], name: sr.name || 'Series', value: q ? m.fmtV(q.v) : '–' };
        });
        const when = m.fmtT(hoverT);
        if (when) {
          /* The pill's width is a function of its text, and scrubbing lands
             on the same day for most frames — so the write and the forced
             layout the measurement costs happen only when the date changes. */
          const txt = String(when);
          if (txt !== pillTxt) {
            FxNum.rollText(pill, txt);
            pillTxt = txt;
            pillW = pill.offsetWidth;
          }
          const pw = pillW;
          const px = Math.round(Math.min(Math.max(m.X.to(hoverT) - pw / 2, 4), Math.max(4, host.clientWidth - pw - 4)));
          pill.style.transform = `translate(${px}px, ${f.plotH - f.padB + 5}px)`;
          pill.classList.add('on');
        } else {
          pill.classList.remove('on');
        }
        // The pill states the date once, so the panel keeps only the values.
        // When the caller's formatTime yields nothing there IS no pill (the
        // branch above hides it), and the panel says the time instead — the
        // timestamp must never vanish from the hover altogether.
        tip.show(when ? '' : fxDate(hoverT), rows, m.X.to(hoverT), y);
      }
    }
    function onMove(e) {
      pendingMove = { x: e.clientX, y: e.clientY };
      if (!moveRaf) moveRaf = requestAnimationFrame(pointerTick);
    }
    function onLeave() {
      if (drag) return; // a drag keeps tracking outside the canvas
      pendingMove = null;
      canvas.style.cursor = '';
      hoverT = null; tip.hide(); pill.classList.remove('on'); render();
    }
    function onUp() {
      if (!drag) return;
      drag = null;
      const f = frame();
      const m = model(f);
      // a window covering (almost) everything is no window at all
      if (win && m.t1 > m.t0 && (win[1] - win[0]) >= (m.t1 - m.t0) * 0.999) win = null;
      tweenY();
    }
    function onDblClick() {
      if (!s.brush || win === null) return;
      win = null; // double-click resets the zoom
      tweenY();
    }

    life.on(canvas, 'mousemove', onMove);
    life.on(canvas, 'mouseleave', onLeave);
    life.on(canvas, 'mousedown', onDown);
    life.on(canvas, 'dblclick', onDblClick);
    // the drag keeps tracking outside the canvas; idle cost is one boolean guard
    life.on(document, 'mousemove', (e) => { if (drag) onMove(e); });
    life.on(document, 'mouseup', onUp);

    render();
    animate(life, 700, (p) => {
      progress = p;
      render();
      if (p >= 1) revealPattern(); // the backdrop lands after the series
    });

    return {
      update(next) {
        s = { ...s, ...next };
        progress = 1; // updates redraw in place; the sweep is a first-paint event
        patternAlpha = 1;
        tweenY(); // the y-domain morphs to the new data — never a re-sweep
      },
      destroy() {
        if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; } // the hover coalescer is a rAF client too
        drag = null;
        canvas.style.cursor = '';
        tip.destroy();
        pill.remove();
        life.destroy();
      },
    };
  }

  /* ═════════════════════ rings(canvas, legendEl, spec) ═════════════════════
     spec: {
       items: [{ name, value, color?, count? }],
       size?: 230, centerLabel?: 'Total',
       formatValue?: fmtBytes,
       onSelect?: (index|null) => void,   // hover sync back to the caller
       onClick?: (index) => void,
     } */
  function rings(canvas, legendEl, spec) {
    const host = anchor(canvas);
    let s = spec, hover = -1, progress = REDUCED ? 1 : 0, hoverAnim = 0, entered = false;
    let centerShown = null; // the morphing center numeral — hover re-counts, update snaps
    const life = makeLife(host, () => render());

    function model() {
      const items = (s.items || []).slice(0, 8);
      const colors = math.ramp(Math.max(1, items.length));
      const segs = math.arcLayout(items.map((it) => it.value));
      const total = items.reduce((a, it) => a + it.value, 0);
      const max = items.reduce((a, it) => Math.max(a, it.value), 1);
      const fmtV = s.formatValue || fmtBytes;
      return { items, colors, segs, total, max, fmtV };
    }

    function render() {
      if (life.dead || document.hidden) return;
      const size = s.size || 230;
      const { ctx } = Canvas2D.setup(canvas, size, size);
      ctx.clearRect(0, 0, size, size);
      const m = model();
      if (!m.items.length) return;
      const cx = size / 2, cy = size / 2;
      const R = size * 0.415, thick = size * 0.075;
      const sweepEnd = -Math.PI / 2 + Math.PI * 2 * progress;

      m.items.forEach((it, i) => {
        const seg = m.segs[i];
        const end = Math.min(seg.end, sweepEnd);
        if (end <= seg.start) return;
        const hl = i === hover;
        const r = R + (hl ? 5 * hoverAnim : 0); // hover translates the slice outward
        ctx.save();
        if (hl && hoverAnim > 0.2) { // the one glow: selection means something
          ctx.shadowColor = it.color || m.colors[i];
          ctx.shadowBlur = 14 * hoverAnim;
        }
        ctx.beginPath();
        ctx.arc(cx, cy, r, seg.start, end);
        ctx.strokeStyle = it.color || m.colors[i];
        ctx.lineWidth = thick + (hl ? 2 * hoverAnim : 0);
        // rounded slice caps by default; cornerRadius: 0 asks for square ends
        ctx.lineCap = s.cornerRadius === 0 ? 'butt' : 'round';
        ctx.globalAlpha = hover === -1 || hl ? 1 : 0.3;
        ctx.stroke();
        ctx.restore();
      });

      // center: big thin numeral over a muted label — bklit's signature.
      // The numeral is the MORPHING value: hover re-counts it toward the
      // hovered slice (see setHover) instead of teleporting.
      const sel = m.items[hover];
      if (centerShown == null) centerShown = m.total;
      ctx.textAlign = 'center';
      ctx.fillStyle = tone('--text-1', '#f2f2f5');
      ctx.font = '200 26px -apple-system, "SF Pro Display", sans-serif';
      ctx.fillText(m.fmtV(centerShown), cx, cy + 2);
      ctx.fillStyle = tone('--text-3', '#8a8a93');
      ctx.font = '500 11px -apple-system, "SF Pro Text", sans-serif';
      ctx.fillText(sel ? sel.name : (s.centerLabel || 'Total'), cx, cy + 20);
    }

    function renderLegend() {
      const m = model();
      legendEl.textContent = '';
      m.items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'fx-li';
        row.dataset.i = String(i);
        const dot = document.createElement('span');
        dot.className = 'fx-dot';
        dot.style.background = it.color || m.colors[i];
        const nm = document.createElement('span');
        nm.className = 'fx-li-name';
        nm.textContent = it.name; // caller strings → textContent, never HTML
        /* count? in the spec is honored here: the old legend's "N files"
           density survives the kit — muted, between name and track. */
        let cnt = null;
        if (it.count != null) {
          cnt = document.createElement('span');
          cnt.className = 'fx-li-cnt fx-num';
          cnt.textContent = formatCount(it.count) + ' files';
          row.classList.add('fx-li-counted');
        }
        const track = document.createElement('span');
        track.className = 'fx-li-track';
        const bar = document.createElement('span');
        bar.className = 'fx-li-bar';
        bar.style.background = it.color || m.colors[i];
        const widthPct = ((it.value / m.max) * 100).toFixed(1) + '%';
        // The grow is an ENTRANCE, so it happens once. update() rebuilds these
        // rows for a live rescan and for the theme handler's identical-data
        // retint; replaying the slide there animates a change that did not
        // happen, while the ring beside it correctly holds still.
        if (REDUCED || entered) bar.style.width = widthPct;
        else requestAnimationFrame(() => { if (!life.dead) bar.style.width = widthPct; });
        track.appendChild(bar);
        const val = document.createElement('span');
        val.className = 'fx-li-val fx-num';
        val.textContent = m.fmtV(it.value);
        const pct = document.createElement('span');
        pct.className = 'fx-li-pct fx-num';
        pct.textContent = (m.segs[i].frac * 100).toFixed(1) + '%';
        if (cnt) row.append(dot, nm, cnt, track, val, pct);
        else row.append(dot, nm, track, val, pct);
        row.addEventListener('mouseenter', () => setHover(i));
        row.addEventListener('mouseleave', () => setHover(-1));
        if (s.onClick) row.addEventListener('click', () => s.onClick(i));
        legendEl.appendChild(row);
      });
      entered = true; // updates re-render without replaying the entrance
    }

    function setHover(i) {
      if (i === hover) return;
      hover = i;
      for (const li of legendEl.querySelectorAll('.fx-li')) {
        li.classList.toggle('hl', Number(li.dataset.i) === i);
      }
      if (s.onSelect) s.onSelect(i === -1 ? null : i);
      life.stopRaf();
      progress = 1; // a hover during the entrance sweep completes it
      hoverAnim = 0;
      /* the pop and the center numeral ride one 220ms curve: the value
         re-counts toward the hovered slice (or back to the total) */
      const m = model();
      const target = i === -1 || !m.items[i] ? m.total : m.items[i].value;
      const from = centerShown == null ? target : centerShown;
      animate(life, 220, (p) => {
        hoverAnim = i === -1 ? 0 : p;
        centerShown = from + (target - from) * p;
        render();
      });
    }

    function onMove(e) {
      const size = s.size || 230;
      const { x, y } = Canvas2D.toLocal(canvas, e.clientX, e.clientY);
      const dx = x - size / 2, dy = y - size / 2;
      const dist = Math.hypot(dx, dy);
      const R = size * 0.415, thick = size * 0.075;
      let hit = -1;
      if (dist >= R - thick && dist <= R + thick) {
        let a = Math.atan2(dy, dx);
        if (a < -Math.PI / 2) a += Math.PI * 2;
        hit = model().segs.findIndex((seg) => a >= seg.start && a < seg.end);
      }
      setHover(hit);
    }
    function onLeave() { setHover(-1); }
    function onClick() { if (hover !== -1 && s.onClick) s.onClick(hover); }

    life.on(canvas, 'mousemove', onMove);
    life.on(canvas, 'mouseleave', onLeave);
    life.on(canvas, 'click', onClick);

    renderLegend();
    render();
    animate(life, 800, (p) => { progress = p; render(); });

    return {
      update(next) {
        // A hover animation in flight writes centerShown every frame from the
        // OLD slice's captured target, so it would overwrite the reseed below
        // and leave the centre showing a slice's bytes under "Top types".
        // area.tweenY() and gauge.ease() stop the raf for the same reason.
        life.stopRaf();
        s = { ...s, ...next };
        hover = -1; progress = 1; hoverAnim = 0;
        centerShown = null; // new data is a new entity — snap, never roll across it
        renderLegend();
        render();
      },
      destroy() { legendEl.textContent = ''; life.destroy(); },
    };
  }

  /* ═════════════════════ gauge(canvas, spec) ═════════════════════
     spec: {
       value: 0..1, label, sublabel?,
       size?: 120, notches?: 40, danger?: false, warn?: false,
       formatValue?: (v) => string,       // value text; default percent
       orientation?: 'arc' | 'linear',    // linear = flat notch track
       linearHeight?: 24,                 // linear track height (px)
       notchCornerRadius?: 1.5,           // linear notch rounding, up to capsule
       activeGradient?: [from, to],       // per-notch color interpolation
     }
     Existing arc call sites pass none of the new keys and render exactly
     as before. */
  function gauge(canvas, spec) {
    const host = anchor(canvas);
    let s = spec, shown = REDUCED ? clamp01(spec.value) : 0;
    const life = makeLife(host, () => render());
    function clamp01(v) { return Math.max(0, Math.min(1, v || 0)); }

    /* linear orientation: the same notch language laid flat — a full-width
       notch track with the value right-aligned beside it. */
    function renderLinear() {
      const w = Math.max(120, host.clientWidth || 160);
      const trackH = s.linearHeight || 24;
      const labelH = s.label ? 16 : 0;
      const h = trackH + labelH;
      const { ctx } = Canvas2D.setup(canvas, w, h);
      ctx.clearRect(0, 0, w, h);
      const notches = s.notches || 40;
      const fmt = s.formatValue || ((v) => Math.round(v * 100) + '%');
      const valTxt = fmt(clamp01(shown));
      const valPx = Math.max(12, Math.round(trackH * 0.62));
      ctx.font = `200 ${valPx}px -apple-system, "SF Pro Display", sans-serif`;
      const trackW = Math.max(40, w - Math.ceil(ctx.measureText(valTxt).width) - 12);
      const lit = Math.round(clamp01(shown) * notches);
      const track = tone('--hairline-2', 'rgba(255,255,255,0.08)');
      // Every colour the kit paints comes through tone(), so a theme flip
      // re-reads it. A raw hex passed in from a call site cannot do that:
      // the capsule's over-85% amber painted ~1.9:1 on light cards.
      const hot = s.danger ? tone('--danger', '#FF453A') : s.warn ? tone('--warn', '#FFD60A') : null;
      const [gFrom, gTo] = s.activeGradient || ['#0A84FF', '#86C1FF'];
      const slot = trackW / notches;
      const nw = Math.max(2, Math.min(6, slot - 2));
      const rad = Math.min(s.notchCornerRadius != null ? s.notchCornerRadius : 1.5, nw / 2);
      for (let i = 0; i < notches; i++) {
        Canvas2D.roundRect(ctx, i * slot + (slot - nw) / 2, 0, nw, trackH, rad);
        if (i < lit) {
          ctx.fillStyle = hot || math.lerpColor(gFrom, gTo, i / (notches - 1));
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = track;
          ctx.globalAlpha = 0.9;
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'right';
      ctx.fillStyle = s.danger ? tone('--danger', '#FF453A') : tone('--text-1', '#f2f2f5');
      ctx.fillText(valTxt, w - 2, trackH / 2 + valPx * 0.36);
      if (s.label) {
        ctx.textAlign = 'left';
        ctx.fillStyle = tone('--text-3', '#8a8a93');
        ctx.font = '500 10.5px -apple-system, "SF Pro Text", sans-serif';
        ctx.fillText(s.label, 0, h - 3);
      }
    }

    function render() {
      if (life.dead || document.hidden) return;
      if (s.orientation === 'linear') { renderLinear(); return; }
      const size = s.size || 120;
      const { ctx } = Canvas2D.setup(canvas, size, size);
      ctx.clearRect(0, 0, size, size);
      const cx = size / 2, cy = size / 2;
      const notches = s.notches || 40;
      const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25; // 135° → 405°
      const rOut = size * 0.44, rIn = size * 0.36;
      const lit = Math.round(clamp01(shown) * notches);
      const track = tone('--hairline-2', 'rgba(255,255,255,0.08)');
      // Every colour the kit paints comes through tone(), so a theme flip
      // re-reads it. A raw hex passed in from a call site cannot do that:
      // the capsule's over-85% amber painted ~1.9:1 on light cards.
      const hot = s.danger ? tone('--danger', '#FF453A') : s.warn ? tone('--warn', '#FFD60A') : null;

      for (let i = 0; i < notches; i++) {
        const a = a0 + ((a1 - a0) * i) / (notches - 1);
        const p1 = math.polar(cx, cy, rIn, a);
        const p2 = math.polar(cx, cy, rOut, a);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        if (i < lit) {
          // per-notch gradient along the ramp: deep blue → ice by default,
          // an activeGradient pair when the caller asks, danger when over
          const [gFrom, gTo] = s.activeGradient || ['#0A84FF', '#86C1FF'];
          ctx.strokeStyle = hot || math.lerpColor(gFrom, gTo, i / (notches - 1));
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = track;
          ctx.globalAlpha = 0.9;
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const fmt = s.formatValue || ((v) => Math.round(v * 100) + '%');
      ctx.textAlign = 'center';
      ctx.fillStyle = s.danger ? tone('--danger', '#FF453A') : tone('--text-1', '#f2f2f5');
      ctx.font = `200 ${Math.round(size * 0.19)}px -apple-system, "SF Pro Display", sans-serif`;
      ctx.fillText(fmt(clamp01(shown)), cx, cy + size * 0.03);
      if (s.label) {
        ctx.fillStyle = tone('--text-3', '#8a8a93');
        ctx.font = '500 10.5px -apple-system, "SF Pro Text", sans-serif';
        ctx.fillText(s.label, cx, cy + size * 0.03 + 16);
      }
      if (s.sublabel) {
        ctx.fillStyle = tone('--text-3', '#8a8a93');
        ctx.font = '400 10px -apple-system, "SF Pro Text", sans-serif';
        ctx.fillText(s.sublabel, cx, size - 4);
      }
    }

    function ease(toV) {
      life.stopRaf();
      const from = shown, target = clamp01(toV);
      // A repaint whose value did not move needs ONE frame, not 600ms of
      // byte-identical ones: the theme handler calls update({}) on every live
      // gauge, so a flip would otherwise start N parallel no-op loops.
      if (REDUCED || target === from) { shown = target; render(); return; }
      animate(life, 600, (p) => { shown = from + (target - from) * p; render(); });
    }

    render();
    ease(s.value);

    return {
      update(next) { s = { ...s, ...next }; ease(s.value); },
      destroy() { life.destroy(); },
    };
  }

  /* ═════════════════════ barList(containerEl, spec) ═════════════════════
     spec: {
       items: [{ name, value, detail?, color? }],
       formatValue?: fmtBytes, max?,
       onClick?: (index) => void,
     } */
  function barList(containerEl, spec) {
    let s = spec;
    const life = makeLife(containerEl, () => { /* pure DOM — no redraw needed */ });

    function render() {
      const fmtV = s.formatValue || fmtBytes;
      const items = s.items || [];
      const max = s.max || items.reduce((m, it) => Math.max(m, it.value), 1);
      containerEl.textContent = '';
      const colors = math.ramp(Math.max(2, Math.min(items.length, 4)));
      items.forEach((it, i) => {
        const row = document.createElement(s.onClick ? 'button' : 'div');
        row.className = 'fx-bar-row';
        if (s.onClick) {
          row.type = 'button';
          row.addEventListener('click', () => s.onClick(i));
        }
        const top = document.createElement('div');
        top.className = 'fx-bar-top';
        const nm = document.createElement('span');
        nm.className = 'fx-bar-name';
        nm.textContent = it.name;
        const val = document.createElement('span');
        val.className = 'fx-bar-val fx-num';
        val.textContent = fmtV(it.value);
        top.append(nm, val);
        const track = document.createElement('div');
        track.className = 'fx-bar-track';
        const bar = document.createElement('div');
        bar.className = 'fx-bar-fill';
        const col = it.color || colors[Math.min(i, colors.length - 1)];
        const rgb = math.hexRgb(col);
        bar.style.background = `linear-gradient(90deg, ${col}, rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.35))`;
        const widthPct = ((it.value / max) * 100).toFixed(1) + '%';
        if (REDUCED) bar.style.width = widthPct;
        else requestAnimationFrame(() => { if (!life.dead) bar.style.width = widthPct; });
        track.appendChild(bar);
        row.append(top, track);
        if (it.detail) {
          const det = document.createElement('div');
          det.className = 'fx-bar-detail';
          det.textContent = it.detail;
          row.appendChild(det);
        }
        containerEl.appendChild(row);
      });
    }

    render();
    return {
      update(next) { s = { ...s, ...next }; render(); },
      destroy() { containerEl.textContent = ''; life.destroy(); },
    };
  }

  /* ═════════════════════ liveLine(canvas, spec) ═════════════════════
     A sliding-window live line with a soft pulsing leading dot.
     spec: {
       windowMs?: 60000, height?: 90, label?,
       formatValue?: fmtBytes,
     }
     handle.push(value, atMs?) appends a sample; the loop scrolls it. */
  function liveLine(canvas, spec) {
    const host = anchor(canvas);
    let s = spec;
    const samples = [];
    // makeLife's visibilitychange redraw doubles as the loop resume — one
    // listener per instance, not two doing half the job each.
    const life = makeLife(host, () => {
      draw();
      if (running && !life.raf && !REDUCED && !document.hidden) life.raf = requestAnimationFrame(loop);
    });
    let running = false;
    let lastDraw = 0;

    function prune(now) {
      const win = s.windowMs || 60000;
      while (samples.length && samples[0].t < now - win - 1000) samples.shift();
    }

    function draw() {
      if (life.dead || document.hidden) return;
      const w = Math.max(160, host.clientWidth || 220);
      const h = s.height || 90;
      const { ctx } = Canvas2D.setup(canvas, w, h);
      ctx.clearRect(0, 0, w, h);
      const now = Date.now();
      prune(now);
      const win = s.windowMs || 60000;
      const padT = 8, padB = 14, padR = 12;
      // the leading gap: "now" stops short of the right edge, and the
      // gridlines fade out through that gap (bklit's nowOffset treatment)
      const lead = Math.max(14, Math.round(w * 0.08));
      const grid = tone('--hairline', 'rgba(255,255,255,0.12)');
      const gridFade = ctx.createLinearGradient(0, 0, w, 0);
      gridFade.addColorStop(0, grid);
      gridFade.addColorStop(Math.max(0, 1 - (lead + padR) / w), grid);
      gridFade.addColorStop(1, math.alpha(grid, 0));
      dottedLine(ctx, 0, w, padT + (h - padT - padB) / 2, gridFade);
      dottedLine(ctx, 0, w, h - padB, gridFade);
      if (!samples.length) return;

      /* momentum re-colors line, fill and dot: rising activity leans
         bright, cooling leans slate — all tokens, all in the blue family */
      const mom = math.momentum(samples.map((p) => p.v));
      const lineCol =
        mom === 'up' ? tone('--fx-live-up', '#4DA3FF') :
        mom === 'down' ? tone('--fx-live-down', '#5E7FA6') :
        tone('--accent', '#0A84FF');

      const [, vMax] = math.extent(samples.map((p) => p.v));
      const X = math.scaleTime(now - win, now, 0, w - padR - lead);
      const Y = math.scaleLinear(0, vMax * 1.15 || 1, h - padB, padT);
      const xs = samples.map((p) => X.to(p.t));
      const ys = samples.map((p) => Y.to(p.v));
      if (samples.length === 1) {
        // area()'s single-point rule, mirrored: the first sample renders as
        // a dot instead of an empty grid pretending nothing arrived.
        ctx.beginPath();
        ctx.arc(xs[0], ys[0], 3, 0, Math.PI * 2);
        ctx.fillStyle = lineCol;
        ctx.fill();
        return;
      }
      const segs = math.monotone(xs, ys);

      const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
      grad.addColorStop(0, math.alpha(lineCol, 0.22));
      grad.addColorStop(1, math.alpha(lineCol, 0));
      ctx.beginPath();
      traceSegs(ctx, segs);
      ctx.lineTo(xs[xs.length - 1], h - padB);
      ctx.lineTo(xs[0], h - padB);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      traceSegs(ctx, segs);
      ctx.strokeStyle = lineCol;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // pulsing live dot with a soft glow — activity is the one thing that glows
      const lx = xs[xs.length - 1], ly = ys[ys.length - 1];
      const pulse = REDUCED ? 0.5 : (Math.sin(now / 300) + 1) / 2;
      ctx.save();
      ctx.shadowColor = lineCol;
      ctx.shadowBlur = 8 + 6 * pulse;
      ctx.beginPath();
      ctx.arc(lx, ly, 3 + 0.6 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = lineCol;
      ctx.fill();
      ctx.restore();

      // value badge riding the tip — a tinted pill, tabular, honest
      const fmtV = s.formatValue || fmtBytes;
      const txt = fmtV(samples[samples.length - 1].v);
      ctx.font = '600 10px -apple-system, "SF Pro Text", sans-serif';
      const tw = Math.ceil(ctx.measureText(txt).width);
      const bw = tw + 12, bh = 16;
      let bx = lx + 9;
      if (bx + bw > w - 1) bx = lx - bw - 9;
      const by = Math.max(1, Math.min(h - bh - 1, ly - bh / 2));
      Canvas2D.roundRect(ctx, bx, by, bw, bh, 8);
      ctx.fillStyle = math.alpha(lineCol, 0.16);
      ctx.fill();
      ctx.strokeStyle = math.alpha(lineCol, 0.4);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = tone('--text-1', '#f2f2f5');
      ctx.fillText(txt, bx + 6, by + 11.5);
      if (s.label) {
        ctx.fillStyle = tone('--text-3', '#8a8a93');
        ctx.font = '500 10px -apple-system, "SF Pro Text", sans-serif';
        ctx.fillText(s.label, 2, h - 3);
      }
    }

    function loop(ts) {
      if (life.dead || !running) return;
      if (document.hidden) { life.raf = 0; return; } // resumes via makeLife's visibility redraw
      // ~15fps is plenty: samples land every 2s and the window scrolls about
      // a pixel a second, so a 60fps redraw would spend three frames in four
      // repainting an identical line for hours of a Live session.
      if (ts - lastDraw >= 66) {
        lastDraw = ts;
        draw();
        // Nothing to scroll with fewer than two samples — sleep entirely;
        // the next push() restarts the loop.
        if (samples.length < 2) { running = false; life.raf = 0; return; }
      }
      life.raf = requestAnimationFrame(loop);
    }
    function start() {
      if (running || life.dead) return;
      running = true;
      if (REDUCED) { draw(); running = false; return; } // discrete redraws only
      if (!document.hidden) life.raf = requestAnimationFrame(loop);
    }

    draw();

    return {
      push(v, atMs) {
        samples.push({ t: atMs || Date.now(), v });
        if (REDUCED) { draw(); return; }
        start();
      },
      update(next) { s = { ...s, ...next }; draw(); },
      destroy() { running = false; life.destroy(); },
    };
  }

  /* ═════════════════════ scatter(canvas, spec) ═════════════════════
     bklit's offset-ring dots: a filled core, a 2px outer ring held off by
     a 2px gap. Hover scales the active point and dims + blurs the rest;
     yGradient colors each dot by its height over the accent ramp.
     spec: {
       points: [{ x, y, label? }],     // x = ms by default, y = bytes
       height?: 240, yGradient?: false | [stops], color?,
       formatX?: fxDate, formatY?: fmtBytes,
       logX?: true | tickBase,         // log10(v+1) axes for skewed domains;
       logY?: true | tickBase,         // a number is the tick base (1024 = byte decades)
       formatXTick?: math.compactCount, // log-x decade labels (10 / 100 / 1k)
     } */
  function scatter(canvas, spec) {
    const host = anchor(canvas);
    const tip = makeTip(host);
    let s = spec, progress = REDUCED ? 1 : 0, hover = -1;
    let dimLayer = null;  // the dimmed crowd, rendered once per hover session
    let dimKey = null;    // what that layer was rendered for
    const life = makeLife(host, () => render());
    const R_CORE = 5, RING_GAP = 2, RING_W = 2; // bklit's offset-ring geometry
    const R_RING = R_CORE + RING_GAP + RING_W / 2;

    function frame() {
      const w = Math.max(240, host.clientWidth || 240);
      const h = s.height || 240;
      return { ...Canvas2D.setup(canvas, w, h), padL: 62, padR: 18, padT: 16, padB: 26 };
    }

    function model(f) {
      const pts = (s.points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
      const fmtX = s.formatX || fxDate;
      const fmtY = s.formatY || fmtBytes;
      const [x0, x1] = math.extent(pts.map((p) => p.x));
      const [, yMax] = math.extent(pts.map((p) => p.y));
      const yLog = !!s.logY;
      const yBase = typeof s.logY === 'number' && s.logY > 1 ? s.logY : 10;
      const ticks = yLog ? math.logTicks(yMax, yBase, 4) : math.niceTicks(0, yMax * 1.05 || 1, 4);
      const top = ticks[ticks.length - 1];
      let X, xTicks = null;
      if (s.logX) {
        const xBase = typeof s.logX === 'number' && s.logX > 1 ? s.logX : 10;
        xTicks = math.logTicks(x1, xBase, 5);
        X = math.scaleLog(xTicks[xTicks.length - 1], f.padL, f.width - f.padR);
      } else {
        const padX = (x1 - x0 || 1) * 0.05; // dots have radius; give them air
        X = math.scaleLinear(x0 - padX, x1 + padX, f.padL, f.width - f.padR);
      }
      const Y = yLog ? math.scaleLog(top, f.height - f.padB, f.padT)
                     : math.scaleLinear(0, top, f.height - f.padB, f.padT);
      return { pts, ticks, top, X, Y, fmtX, fmtY, x0, x1, xTicks, yLog };
    }

    function dotColor(m, p) {
      if (s.yGradient) {
        // A log y-axis samples the ramp in log space too, or every mid-size
        // dot would crush into the bottom stop while the axis spreads them.
        const t = m.yLog
          ? Math.log10(Math.max(0, p.y) + 1) / (Math.log10(m.top + 1) || 1)
          : (m.top > 0 ? p.y / m.top : 0);
        return math.sampleRamp(t, Array.isArray(s.yGradient) ? s.yGradient : undefined);
      }
      return s.color || tone('--accent', '#0A84FF');
    }

    function drawDot(ctx, x, y, col, scale) {
      ctx.beginPath();
      ctx.arc(x, y, R_CORE * scale, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, R_RING * scale, 0, Math.PI * 2);
      ctx.strokeStyle = col;
      ctx.lineWidth = RING_W;
      ctx.stroke();
    }

    /** Every dot but `skip`, at `alphaMul` × its own slice of the reveal. */
    function drawCrowd(ctx, m, dScale, alphaMul, skip) {
      const n = m.pts.length;
      m.pts.forEach((p, i) => {
        if (i === skip) return;
        // staggered reveal: each dot rides its own slice of the sweep
        const tI = n > 1 ? Math.min(1, Math.max(0, (progress - (i / n) * 0.55) / 0.45)) : progress;
        if (tI <= 0) return;
        ctx.globalAlpha = alphaMul * tI;
        drawDot(ctx, m.X.to(p.x), m.Y.to(p.y), dotColor(m, p), (0.6 + 0.4 * tI) * dScale);
      });
      ctx.globalAlpha = 1;
    }

    function render(f, m) {
      if (life.dead || document.hidden) return;
      if (!f) f = frame();
      if (!m) m = model(f);
      const { ctx } = f;
      ctx.clearRect(0, 0, f.width, f.height);
      const grid = tone('--hairline', 'rgba(255,255,255,0.12)');
      const lab = tone('--text-3', '#8a8a93');
      ctx.font = '10.5px -apple-system, "SF Pro Text", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = lab;
      for (const v of m.ticks) {
        const y = m.Y.to(v);
        dottedLine(ctx, f.padL, f.width - f.padR, y, grid);
        ctx.fillText(v === 0 ? '0 B' : m.fmtY(v), f.padL - 8, y + 3.5);
      }
      if (!m.pts.length) {
        ctx.textAlign = 'center';
        ctx.fillText('No data yet.', f.width / 2, f.height / 2);
        return;
      }
      ctx.textAlign = 'center';
      if (m.xTicks) {
        // decade labels along the log x-axis (10 / 100 / 1k / 10k) with the
        // real maximum as the last one; the origin stays unlabeled — it would
        // collide with the y-axis "0 B"
        const fmtT = s.formatXTick || math.compactCount;
        for (const v of m.xTicks) {
          if (v > 0) ctx.fillText(fmtT(v), m.X.to(v), f.height - 8);
        }
      } else {
        ctx.fillText(m.fmtX(m.x0), f.padL + 24, f.height - 8);
        if (m.x1 > m.x0) ctx.fillText(m.fmtX(m.x1), f.width - f.padR - 24, f.height - 8);
      }

      const n = m.pts.length;
      const dScale = math.densityScale(n); // a crowded scatter shrinks its dots
      const dimmed = hover !== -1;
      const blurred = dimmed && 'filter' in ctx;
      // one pass for the crowd (dim + blur while a point is active) …
      if (blurred) {
        /* The blur is applied ONCE, to a cached blit of the whole crowd —
           never per dot. A canvas filter rasterizes every drawing operation
           under it into its own layer, and the apps scatter carries a point
           per app (~300 = ~600 arcs), while `hit` changes on nearly every
           frame of a sweep through a dense cluster. The layer includes the
           active dot, which is what makes it constant for the whole hover
           session: the sharp scaled copy below covers it. */
        const key = f.width + '|' + f.height + '|' + n + '|' + progress + '|' + dScale;
        if (!dimLayer) dimLayer = document.createElement('canvas');
        if (dimKey !== key) {
          dimKey = key;
          const lf = Canvas2D.setup(dimLayer, f.width, f.height);
          lf.ctx.clearRect(0, 0, f.width, f.height);
          drawCrowd(lf.ctx, m, dScale, 0.5, -1);
        }
        ctx.save();
        ctx.filter = 'blur(2px)';
        ctx.drawImage(dimLayer, 0, 0, f.width, f.height);
        ctx.restore();
      } else {
        ctx.save();
        drawCrowd(ctx, m, dScale, dimmed ? 0.5 : 1, hover);
        ctx.restore();
      }
      // … and the active point sharp, scaled and glowing on top
      if (hover !== -1 && m.pts[hover]) {
        const p = m.pts[hover];
        const col = dotColor(m, p);
        ctx.save();
        ctx.shadowColor = col;
        ctx.shadowBlur = 10;
        drawDot(ctx, m.X.to(p.x), m.Y.to(p.y), col, 1.25 * dScale);
        ctx.restore();
      }
    }

    let pendingMove = null;
    let moveRaf = 0;
    function onMove(e) {
      pendingMove = { x: e.clientX, y: e.clientY };
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        const mv = pendingMove;
        if (!mv || life.dead) return;
        const f = frame();
        const m = model(f);
        if (!m.pts.length) return;
        const { x, y } = Canvas2D.toLocal(canvas, mv.x, mv.y);
        let hit = -1, bd = 14 * 14;
        m.pts.forEach((p, i) => {
          const dx = m.X.to(p.x) - x, dy = m.Y.to(p.y) - y;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; hit = i; }
        });
        if (hit !== hover) {
          // rings.setHover's precedent: without the stop, the entrance's next
          // frame writes its eased progress back over the 1 and both loops
          // render the dim pass in the same frame.
          life.stopRaf();
          hover = hit;
          progress = 1; // a hover during the reveal completes it
          render(f, m);
        }
        if (hit !== -1) {
          const p = m.pts[hit];
          tip.show(p.label || '', [{ color: dotColor(m, p), name: m.fmtX(p.x), value: m.fmtY(p.y) }],
            m.X.to(p.x), m.Y.to(p.y));
        } else {
          tip.hide();
        }
      });
    }
    function onLeave() {
      pendingMove = null;
      tip.hide();
      if (hover !== -1) { hover = -1; render(); }
    }
    life.on(canvas, 'mousemove', onMove);
    life.on(canvas, 'mouseleave', onLeave);

    render();
    animate(life, 1100, (p) => { progress = p; render(); }, math.easeMaster);

    return {
      update(next) {
        s = { ...s, ...next };
        hover = -1; progress = 1;
        dimKey = null; // new data (or a retint) is a new crowd
        render();
      },
      destroy() {
        if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
        dimLayer = null;
        tip.destroy();
        life.destroy();
      },
    };
  }

  /* ═════════════════════ profitLine(canvas, spec) ═════════════════════
     bklit's profit/loss line: one series, straight segments, split at the
     EXACT zero crossings (math.zeroSplit) so gains and losses each hold
     their own tone; the zero row is the emphasized gridline. Tones stay
     in the blue/black family — accent above, the slate counterpart below
     — and both come from tokens so light mode re-tunes them.
     spec: {
       points: [{ t, v }],            // v may be negative (deltas)
       height?: 220,
       formatValue?: signed bytes, formatTime?: fxDate,
       posName?: 'Grew', negName?: 'Freed',
     } */
  function profitLine(canvas, spec) {
    const host = anchor(canvas);
    const tip = makeTip(host);
    let s = spec, progress = REDUCED ? 1 : 0, hoverT = null;
    const life = makeLife(host, () => render());

    const fmtSigned = (v) => (v < 0 ? '−' : '+') + fmtBytes(Math.abs(v));
    const toneFor = (v) => (v < 0 ? tone('--fx-neg', '#5E7FA6') : tone('--accent', '#0A84FF'));

    function frame() {
      const w = Math.max(260, host.clientWidth || 260);
      const h = s.height || 220;
      return { ...Canvas2D.setup(canvas, w, h), padL: 62, padR: 14, padT: 14, padB: 26 };
    }

    function model(f) {
      const fmtV = s.formatValue || fmtSigned;
      const fmtT = s.formatTime || fxDate;
      const pts = (s.points || []).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v));
      const [t0, t1] = math.extent(pts.map((p) => p.t));
      const [vLo, vHi] = math.extent(pts.map((p) => p.v));
      // zero always inside the domain: the chart argues about that axis
      const ticks = math.niceTicks(Math.min(0, vLo * 1.05), Math.max(0, vHi * 1.05) || 1, 4);
      const X = math.scaleTime(t0, t1, f.padL, f.width - f.padR);
      const Y = math.scaleLinear(ticks[0], ticks[ticks.length - 1], f.height - f.padB, f.padT);
      const runs = math.zeroSplit(pts.map((p) => ({ x: p.t, y: p.v })));
      return { pts, runs, ticks, X, Y, t0, t1, fmtV, fmtT };
    }

    function nearestPt(pts, t) {
      let best = null, bd = Infinity;
      for (const p of pts) {
        const d = Math.abs(p.t - t);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }

    function render(f, m) {
      if (life.dead || document.hidden) return;
      if (!f) f = frame();
      if (!m) m = model(f);
      const { ctx } = f;
      ctx.clearRect(0, 0, f.width, f.height);
      const grid = tone('--hairline', 'rgba(255,255,255,0.12)');
      const lab = tone('--text-3', '#8a8a93');
      ctx.font = '10.5px -apple-system, "SF Pro Text", sans-serif';
      ctx.textAlign = 'right';
      for (const v of m.ticks) {
        const y = m.Y.to(v);
        if (v === 0) {
          // the emphasized zero row — solid, foreground at 0.35
          ctx.save();
          ctx.strokeStyle = math.alpha(tone('--text-1', '#f2f2f5'), 0.35);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(f.padL, Math.round(y) + 0.5);
          ctx.lineTo(f.width - f.padR, Math.round(y) + 0.5);
          ctx.stroke();
          ctx.restore();
        } else {
          dottedLine(ctx, f.padL, f.width - f.padR, y, grid);
        }
        ctx.fillStyle = lab;
        ctx.fillText(v === 0 ? '0 B' : m.fmtV(v), f.padL - 8, y + 3.5);
      }
      if (!m.pts.length) {
        ctx.textAlign = 'center';
        ctx.fillStyle = lab;
        ctx.fillText('No data yet.', f.width / 2, f.height / 2);
        return;
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = lab;
      ctx.fillText(m.fmtT(m.t0), f.padL + 24, f.height - 8);
      if (m.t1 > m.t0) ctx.fillText(m.fmtT(m.t1), f.width - f.padR - 24, f.height - 8);

      // draw-in sweep, master-eased; runs are straight segments on purpose
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, f.padL + (f.width - f.padL - f.padR) * progress + 2, f.height);
      ctx.clip();
      for (const run of m.runs) {
        if (run.points.length < 2) continue;
        ctx.beginPath();
        run.points.forEach((p, i) => {
          const x = m.X.to(p.x), y = m.Y.to(p.y);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = run.sign < 0 ? tone('--fx-neg', '#5E7FA6') : tone('--accent', '#0A84FF');
        ctx.globalAlpha = run.sign === 0 ? 0.6 : 1; // flat-on-zero stretches whisper
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      // sign-aware crosshair dot
      if (hoverT !== null) {
        const p = nearestPt(m.pts, hoverT);
        if (p) {
          const hx = m.X.to(p.t);
          const chCol = tone('--text-3', '#8a8a93');
          const chGrad = ctx.createLinearGradient(0, f.padT, 0, f.height - f.padB);
          chGrad.addColorStop(0, math.alpha(chCol, 0));
          chGrad.addColorStop(0.1, chCol);
          chGrad.addColorStop(0.9, chCol);
          chGrad.addColorStop(1, math.alpha(chCol, 0));
          ctx.save();
          ctx.setLineDash([1, 3]);
          ctx.strokeStyle = chGrad;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(Math.round(hx) + 0.5, f.padT);
          ctx.lineTo(Math.round(hx) + 0.5, f.height - f.padB);
          ctx.stroke();
          ctx.restore();
          ctx.beginPath();
          ctx.arc(hx, m.Y.to(p.v), 3.5, 0, Math.PI * 2);
          ctx.fillStyle = toneFor(p.v);
          ctx.fill();
          ctx.strokeStyle = tone('--bg-1', '#0e0e13');
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    let pendingMove = null;
    let moveRaf = 0;
    function onMove(e) {
      pendingMove = { x: e.clientX, y: e.clientY };
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        const mv = pendingMove;
        if (!mv || life.dead) return;
        const f = frame();
        const m = model(f);
        if (!m.pts.length) return;
        const { x, y } = Canvas2D.toLocal(canvas, mv.x, mv.y);
        const t = m.X.from(Math.max(f.padL, Math.min(f.width - f.padR, x)));
        const p = nearestPt(m.pts, t);
        hoverT = p ? p.t : null;
        render(f, m);
        if (p) {
          tip.show(m.fmtT(p.t), [{
            color: toneFor(p.v),
            name: p.v < 0 ? (s.negName || 'Freed') : (s.posName || 'Grew'),
            value: m.fmtV(p.v),
          }], m.X.to(p.t), y);
        }
      });
    }
    function onLeave() {
      pendingMove = null;
      hoverT = null; tip.hide(); render();
    }
    life.on(canvas, 'mousemove', onMove);
    life.on(canvas, 'mouseleave', onLeave);

    render();
    animate(life, 1100, (p) => { progress = p; render(); }, math.easeMaster);

    return {
      update(next) {
        s = { ...s, ...next };
        progress = 1; // updates redraw in place; the sweep is a first-paint event
        render();
      },
      destroy() {
        if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
        tip.destroy();
        life.destroy();
      },
    };
  }

  /* ═════════════════════ funnel(el, spec) ═════════════════════
     DOM funnel: each stage a rounded segment sized against the FIRST
     stage, three concentric halo rings (box-shadow spread), 4px gaps,
     0.12s staggered entrance, name + value + percent badge. Horizontal
     lays stages left → right with centred heights; vertical stacks them
     with centred widths. Hover dims the other stages via CSS alone.
     spec: {
       stages: [{ name, value }],
       orientation?: 'horizontal' | 'vertical',
       trackSize?: 120,               // px across the value axis (horizontal)
       formatValue?: fmtBytes,
     } */
  function funnel(el, spec) {
    let s = spec, entered = false;
    const life = makeLife(el, () => { /* pure DOM — flex owns the geometry */ });

    function render() {
      const fmtV = s.formatValue || fmtBytes;
      const stages = (s.stages || []).filter((st) => st && st.name != null);
      const vertical = s.orientation === 'vertical';
      el.textContent = '';
      el.classList.add('fx-funnel');
      el.classList.toggle('fx-funnel-v', vertical);
      if (!stages.length) {
        const empty = document.createElement('div');
        empty.className = 'fx-empty';
        empty.textContent = 'No data yet.';
        el.appendChild(empty);
        return;
      }
      const layout = math.funnelLayout(stages.map((st) => st.value));
      const colors = math.ramp(Math.max(2, stages.length));
      const doEnter = !entered && !REDUCED && !document.hidden;
      stages.forEach((st, i) => {
        const stage = document.createElement('div');
        stage.className = 'fx-fun-stage';
        const trk = document.createElement('div');
        trk.className = 'fx-fun-track';
        if (!vertical && s.trackSize) trk.style.height = s.trackSize + 'px';
        const seg = document.createElement('div');
        seg.className = 'fx-fun-seg';
        if (st.value > 0) {
          const col = colors[i];
          const rgb = math.hexRgb(col);
          seg.style.background = col;
          // three concentric halo rings, riding the segment's radius
          seg.style.boxShadow =
            `0 0 0 2px rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.16), ` +
            `0 0 0 4px rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.08), ` +
            `0 0 0 6px rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.04)`;
          const pct = (Math.max(layout[i].frac, 0.03) * 100).toFixed(1) + '%';
          if (vertical) seg.style.width = pct;
          else seg.style.height = pct;
        } else {
          seg.classList.add('fx-fun-zero'); // an empty stage is a hairline, not a lie
        }
        trk.appendChild(seg);
        const meta = document.createElement('div');
        meta.className = 'fx-fun-meta';
        const nm = document.createElement('span');
        nm.className = 'fx-fun-name';
        nm.textContent = st.name;
        const val = document.createElement('span');
        val.className = 'fx-fun-val fx-num';
        val.textContent = fmtV(st.value);
        const pctEl = document.createElement('span');
        pctEl.className = 'fx-fun-pct fx-num';
        pctEl.textContent = Math.round(layout[i].pct) + '%';
        meta.append(nm, val, pctEl);
        stage.append(trk, meta);
        if (doEnter) {
          seg.classList.add('fx-fun-pre');
          seg.style.transitionDelay = (i * 120) + 'ms'; // bklit's 0.12s stagger
        }
        el.appendChild(stage);
      });
      if (doEnter) {
        requestAnimationFrame(() => {
          if (life.dead) return;
          for (const sg of el.querySelectorAll('.fx-fun-pre')) sg.classList.remove('fx-fun-pre');
        });
      }
      entered = true; // updates re-render without replaying the entrance
    }

    render();
    return {
      update(next) { s = { ...s, ...next }; render(); },
      destroy() {
        el.textContent = '';
        el.classList.remove('fx-funnel', 'fx-funnel-v');
        life.destroy();
      },
    };
  }

  /* ═════════════════════ barSquares(el, spec) ═════════════════════
     bklit's BarSquares: each bar a bottom-up stack of discrete rounded
     squares (3px gaps, 0.25 corner ratio); the unfilled remainder stays
     visible as ghost squares — the column track that shrinks as the
     stack fills. Cascade-upward entrance; optional ramp gradient by row.
     Long names ellipse under their column; the tooltip carries them
     whole.
     spec: {
       items: [{ name, value }],
       height?: 126, squareSize?: 16,   // squares stay square
       gradient?: false, max?, formatValue?: fmtBytes,
       valueName?: 'Size',              // the tooltip's row label
       labelWidth?,                     // column min-width, so short word labels survive
     } */
  function barSquares(el, spec) {
    let s = spec, entered = false;
    el.style.position = 'relative'; // the tooltip anchors to the container itself
    const tip = makeTip(el);
    /* The columns scroll; the tooltip must not. `.fx-tip` is absolutely
       positioned against whatever makeTip was handed, so hosting it inside the
       scroller would lay it out in CONTENT coordinates — it would drift by
       scrollLeft — and makeTip's edge flip, which measures the VISIBLE
       clientWidth, would flip against the wrong box. One inner track keeps the
       anchor, the flip and the rects the hover reads in the same space. */
    const track = document.createElement('div');
    track.className = 'fx-bsq-track';
    el.appendChild(track);
    const life = makeLife(el, () => { /* pure DOM — flex owns the geometry */ });
    const GAP = 3, CORNER = 0.25; // bklit's square geometry

    function render() {
      const fmtV = s.formatValue || fmtBytes;
      const items = s.items || [];
      track.textContent = '';
      el.classList.add('fx-bsq');
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'fx-empty';
        empty.textContent = 'No data yet.';
        track.appendChild(empty);
        return;
      }
      const size = s.squareSize || 16;
      const H = s.height || 126;
      const rows = Math.max(1, Math.floor((H + GAP) / (size + GAP)));
      const max = s.max || items.reduce((mx, it) => Math.max(mx, it.value), 0) || 1;
      const doEnter = !entered && !REDUCED && !document.hidden;
      items.forEach((it, ci) => {
        const col = document.createElement('div');
        col.className = 'fx-bsq-col';
        // The name lives under the column and can never exceed its width, so
        // a caller with word labels widens the column rather than the square.
        col.style.width = Math.max(size, s.labelWidth || 0) + 'px';
        const stack = document.createElement('div');
        stack.className = 'fx-bsq-stack';
        stack.style.height = (rows * (size + GAP) - GAP) + 'px';
        stack.style.gap = GAP + 'px';
        const lit = math.squareStack(it.value, max, rows);
        for (let r = rows - 1; r >= 0; r--) { // DOM top → bottom; the fill lives at the bottom
          const sq = document.createElement('span');
          const isLit = r < lit;
          sq.className = isLit ? 'fx-bsq-sq' : 'fx-bsq-sq fx-bsq-ghost';
          sq.style.width = size + 'px';
          sq.style.height = size + 'px';
          sq.style.borderRadius = Math.round(size * CORNER) + 'px';
          if (isLit) {
            sq.style.background = s.gradient
              ? math.sampleRamp(rows > 1 ? r / (rows - 1) : 0)
              : 'var(--accent)';
            if (doEnter) {
              sq.classList.add('fx-bsq-pre');
              sq.style.transitionDelay = (ci * 60 + r * 35) + 'ms'; // the upward cascade
            }
          }
          stack.appendChild(sq);
        }
        const nm = document.createElement('div');
        nm.className = 'fx-bsq-name';
        nm.textContent = it.name;
        col.append(stack, nm);
        col.addEventListener('mouseenter', () => {
          const r1 = col.getBoundingClientRect(), r0 = el.getBoundingClientRect();
          tip.show(it.name, [{ name: s.valueName || 'Size', value: fmtV(it.value) }], r1.left - r0.left + r1.width / 2, 16);
        });
        col.addEventListener('mouseleave', () => tip.hide());
        track.appendChild(col);
      });
      if (doEnter) {
        requestAnimationFrame(() => {
          if (life.dead) return;
          for (const sq of el.querySelectorAll('.fx-bsq-pre')) sq.classList.remove('fx-bsq-pre');
        });
      }
      entered = true; // updates re-render without replaying the cascade
    }

    render();
    return {
      update(next) { s = { ...s, ...next }; render(); },
      destroy() {
        tip.destroy();
        el.textContent = '';
        el.classList.remove('fx-bsq');
        life.destroy();
      },
    };
  }

  /* ═════════════════════ radar(canvas, spec) ═════════════════════
     spec: {
       axes: [{ label, short?, value, detail? }],   // value: 0–1, or null
       size?: 200, rings?: 5,
       formatValue?: (v) => string,                 // default: percent
       ariaLabel?: string
     }

     Built for the reclaim score's six signals, and it inherits that score's
     one rule: a signal that could not answer is LEFT OUT, never drawn as a
     zero. Such an axis keeps its spoke — dashed and muted, so you can see
     what was not measured — but gets no vertex, and the outline breaks
     around it rather than chording past.

     The mount is bklit's four-phase choreography: rings scale in, spokes
     grow outward, labels fade, then the shape expands from the centre. */
  function radar(canvas, spec) {
    const host = anchor(canvas);
    const tip = makeTip(host);
    let s = spec, hover = -1;
    let p = REDUCED ? 1 : 0;                 // one clock, four phases
    const life = makeLife(host, () => render());

    const axes = () => (s.axes || []);
    const vals = () => axes().map((a) => (typeof a.value === 'number' && Number.isFinite(a.value) ? a.value : null));
    const fmt = (v) => (s.formatValue ? s.formatValue(v) : Math.round(v * 100) + '%');

    function frame() {
      /* Wider than tall on purpose. The labels sit OUTSIDE the rim, and the
         four diagonal ones run horizontally away from it — on a square canvas
         "Backed up" lost its first four characters to the edge. Height bounds
         the rim; width has to carry the rim plus the longest label. */
      const h = s.size || 200;
      const w = s.width || Math.round(h * 1.4);
      const f = Canvas2D.setup(canvas, w, h);
      return { ...f, cx: w / 2, cy: h / 2, R: Math.min(h / 2 - 22, w / 2 - 62) };
    }

    /** Phase p0..p1 of the shared clock, eased into its own 0..1. */
    const phase = (a, b) => Math.max(0, Math.min(1, (p - a) / (b - a)));

    function render() {
      if (life.dead || document.hidden) return;
      const f = frame();
      const { ctx, cx, cy, R } = f;
      const n = axes().length;
      ctx.clearRect(0, 0, f.width, f.height);
      if (!n) return;

      const grid = tone('--hairline-2', 'rgba(255,255,255,0.10)');
      const accent = tone('--accent', '#0A84FF');
      const muted = tone('--text-3', '#8a8a93');
      const rings = s.rings || 5;

      // ── phase 1: the rings scale in ──
      const pRings = phase(0, 0.35);
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      for (let r = 1; r <= rings; r++) {
        ctx.beginPath();
        ctx.arc(cx, cy, R * (r / rings) * pRings, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ── phase 2: the spokes grow outward ──
      const pSpokes = phase(0.2, 0.55);
      for (let i = 0; i < n; i++) {
        const answered = vals()[i] !== null;
        const end = math.radarPoint(cx, cy, R * pSpokes, i, n, 1);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(end.x, end.y);
        // an unmeasured signal says so on its own spoke
        if (!answered) ctx.setLineDash([2, 4]);
        ctx.strokeStyle = grid;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }

      // ── phase 4: the shape expands from the centre ──
      const pShape = phase(0.45, 1);
      const v = vals();
      const pts = v.map((val, i) => math.radarPoint(cx, cy, R * pShape, i, n, val));
      const runs = math.radarRuns(v);
      const complete = runs.length === 1 && runs[0].closed;

      for (const run of runs) {
        ctx.beginPath();
        for (let k = 0; k < run.len; k++) {
          const pt = pts[(run.start + k) % n];
          if (k === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
        }
        if (run.closed) {
          ctx.closePath();
          /* Only a complete shape is filled: a partial fill would give the
             missing axes an area they never earned. */
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
          g.addColorStop(0, math.alpha(accent, 0.30));
          g.addColorStop(1, math.alpha(accent, 0.10));
          ctx.fillStyle = g;
          ctx.fill();
        }
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      // vertices, the hovered one grown
      for (let i = 0; i < n; i++) {
        const pt = pts[i];
        if (!pt) continue;
        const on = i === hover;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, on ? 5 : 3.2, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
        if (on) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
          ctx.strokeStyle = math.alpha(accent, 0.45);
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // ── phase 3: the labels fade in ──
      const pLabels = phase(0.5, 0.9);
      if (pLabels > 0) {
        ctx.save();
        ctx.globalAlpha = pLabels;
        ctx.font = '500 10px -apple-system, "SF Pro Text", sans-serif';
        for (let i = 0; i < n; i++) {
          const a = axes()[i];
          const answered = v[i] !== null;
          const at = math.radarPoint(cx, cy, R + 15, i, n, 1);
          const ang = math.radarAngle(i, n);
          ctx.textAlign = Math.abs(Math.cos(ang)) < 0.3 ? 'center' : (Math.cos(ang) > 0 ? 'left' : 'right');
          ctx.textBaseline = Math.sin(ang) > 0.6 ? 'top' : (Math.sin(ang) < -0.6 ? 'bottom' : 'middle');
          ctx.fillStyle = i === hover ? tone('--text-1', '#f2f2f5') : (answered ? tone('--text-2', '#c7c7cc') : muted);
          ctx.fillText(a.short || a.label, at.x, at.y);
        }
        ctx.restore();
      }
      if (complete) { /* the shape speaks for itself */ }
    }

    function onMove(e) {
      const f = frame();
      const { x, y } = Canvas2D.toLocal(canvas, e.clientX, e.clientY);
      const n = axes().length;
      const hit = math.radarHit(f.cx, f.cy, f.R, n, x, y);
      if (hit !== hover) { hover = hit; render(); }
      const a = hit === -1 ? null : axes()[hit];
      if (!a) { tip.hide(); return; }
      const answered = typeof a.value === 'number' && Number.isFinite(a.value);
      tip.show(a.label, [{ name: answered ? fmt(a.value) : 'not measured', value: '' },
                          ...(a.detail ? [{ name: a.detail, value: '' }] : [])], x, y);
    }
    function onLeave() { if (hover !== -1) { hover = -1; render(); } tip.hide(); }

    life.on(canvas, 'mousemove', onMove);
    life.on(canvas, 'mouseleave', onLeave);
    if (s.ariaLabel) canvas.setAttribute('aria-label', s.ariaLabel);

    render();
    animate(life, 900, (t) => { p = t; render(); });

    return {
      update(next) { s = { ...s, ...next }; hover = -1; p = 1; render(); },
      destroy() { tip.destroy(); life.destroy(); },
    };
  }

  return { area, rings, gauge, barList, liveLine, scatter, funnel, profitLine, barSquares, radar, ramp: math.ramp, math };
})();
/* ═══ end FX: Charts ═══ */

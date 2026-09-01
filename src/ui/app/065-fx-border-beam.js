/* ═══════════════ FX: Border Beam ═══════════════
   Vanilla port of the border-beam library (React → plain JS).
   Five types, one voice:
     rotate family — "md" (full ring), "sm" (compact ring), "line" (bottom
     traveling glow with breathe + spike oscillators);
     pulse family  — "pulse-inner" (contained breathe), "pulse-outside"
     (outward halo behind the element).
   The colorful/sunset palettes were NOT ported; every gradient stop below is
   re-tuned into the app's blue/black family built from --accent #0A84FF,
   using the original "ocean" variant as the structural reference (same
   positions, sizes, offsets and alpha ladders — only hues moved).

   API:  FxBeam.attach(el, { type, active, duration?, strength?, opacity?,
                             brightness?, saturation?, hueRange?, staticColors?,
                             bloom?, borderRadius?, onActivate?, onDeactivate? })
         FxBeam.detach(el)
   attach is idempotent — attaching to an already-attached element
   reconfigures it in place (same instance, and the same shared stylesheet
   whenever the build key is unchanged).
   The per-attach knobs are the upstream types.ts per-instance props:
   opacity multiplies strength (PORT_PLAN: both clamp to [0,1] — four
   upstream presets exceed 1); brightness/saturation override this
   instance's --fxb-*-bright/-sat tokens; hueRange caps the drift at ±deg
   (clamped to the upstream 30° maximum — the palette itself stays blue);
   staticColors kills the hue drift while motion continues; bloom:false
   drops the blurred conic layer (ambience weight); borderRadius
   skips the computed-style read; onActivate/onDeactivate fire on the
   lit/unlit edges (detach of a lit beam counts as a deactivation). Every
   knob is optional and normalizeOpts leaves unspecified ones out entirely,
   so pre-knob call sites see the exact shape they always did.

   Behaviour contract:
   - Honors the app's REDUCED const: no rotation, no travel, no pulse — a
     static subtle glow instead, applied and removed instantly (no fades).
   - Pauses when document.hidden and when scrolled offscreen
     (IntersectionObserver, 256px early margin), like the original.
   - Zero idle cost when inactive: no rAF, no timers, no matching animation
     selectors once the fade-out completes.
   - The pulse breathing runs on ONE shared ~30fps rAF loop across all
     instances (port of pulseDriver.ts) and stops entirely when no pulse
     instance is active.
   Scalar tuning (per-type opacities, saturation, brightness, shadows) lives
   in the FX: Border Beam styles block as --fxb-* custom properties, dark on
   :root with :root[data-theme="light"] overrides, so those flip with the
   theme live; structural theme differences (line palette geometry, pulse
   oscillator parameters) regenerate via a data-theme MutationObserver. */
const FxBeam = (() => {
  const TYPES = ['md', 'sm', 'line', 'pulse-inner', 'pulse-outside'];

  /* ── Palette — the blue/black family (ocean-derived, --accent-anchored) ──
     Every rgb is a comma-joined triplet so gradients can wrap it in either
     rgb() or rgba(). Positions/sizes are verbatim from the original tables. */
  const PALETTE = {
    /* md ring + both pulse types build from these 9 blobs. */
    border: [
      { rgb: '70, 105, 235',  x: '33%',   y: '-7.4%', w: 70,  h: 40 },
      { rgb: '10, 132, 255',  x: '12%',   y: '-5%',   w: 60,  h: 35 },
      { rgb: '45, 100, 210',  x: '2.1%',  y: '68.3%', w: 40,  h: 70 },
      { rgb: '64, 156, 255',  x: '2.1%',  y: '68.3%', w: 20,  h: 35 },
      { rgb: '90, 140, 255',  x: '74.4%', y: '100%',  w: 180, h: 32 },
      { rgb: '30, 150, 255',  x: '55%',   y: '100%',  w: 85,  h: 26 },
      { rgb: '110, 170, 255', x: '93.9%', y: '0%',    w: 74,  h: 32 },
      { rgb: '60, 130, 240',  x: '100%',  y: '27.1%', w: 26,  h: 42 },
      { rgb: '100, 150, 255', x: '100%',  y: '27.1%', w: 52,  h: 48 },
    ],
    /* sm — compact blobs for ~70×36 controls; inner layer reuses these at
       the original alpha ladder. */
    small: [
      { rgb: '40, 145, 235', x: '2%',   y: '68%',  w: 9,  h: 18 },
      { rgb: '30, 120, 210', x: '2%',   y: '68%',  w: 4,  h: 8  },
      { rgb: '80, 120, 250', x: '72%',  y: '-3%',  w: 59, h: 9  },
      { rgb: '10, 132, 255', x: '74%',  y: '100%', w: 42, h: 7  },
      { rgb: '95, 145, 255', x: '100%', y: '27%',  w: 10, h: 17 },
      { rgb: '60, 115, 240', x: '100%', y: '27%',  w: 10, h: 18 },
      { rgb: '35, 140, 255', x: '100%', y: '27%',  w: 5,  h: 10 },
      { rgb: '85, 135, 245', x: '100%', y: '27%',  w: 11, h: 12 },
    ],
    smallInnerAlphas: [0.5, 0.45, 0.35, 0.35, 0.3, 0.4, 0.3, 0.3],
    /* line — traveling-glow blob fields; geometry differs per theme in the
       original, so both tables ship. dx/dy are px offsets from the beam x. */
    line: {
      dark: [
        { rgb: '70, 110, 240',  w: 36, h: 36, dx: 0,   dy: 2  },
        { rgb: '10, 132, 255',  w: 30, h: 32, dx: 39,  dy: 0  },
        { rgb: '50, 110, 215',  w: 33, h: 28, dx: -36, dy: 2  },
        { rgb: '95, 125, 255',  w: 29, h: 34, dx: -54, dy: 0  },
        { rgb: '40, 150, 255',  w: 27, h: 30, dx: 51,  dy: -1 },
        { rgb: '85, 140, 255',  w: 36, h: 24, dx: 21,  dy: 1  },
        { rgb: '60, 120, 235',  w: 30, h: 22, dx: -21, dy: 0  },
        { rgb: '75, 130, 245',  w: 25, h: 28, dx: 66,  dy: 1  },
        { rgb: '105, 155, 255', w: 23, h: 30, dx: -66, dy: -1 },
      ],
      light: [
        { rgb: '25, 75, 200',  w: 45, h: 36, dx: 0,    dy: 2  },
        { rgb: '10, 100, 225', w: 35, h: 32, dx: 65,   dy: 0  },
        { rgb: '40, 90, 195',  w: 40, h: 28, dx: -60,  dy: 2  },
        { rgb: '70, 85, 225',  w: 35, h: 34, dx: -90,  dy: 0  },
        { rgb: '20, 110, 235', w: 38, h: 30, dx: 85,   dy: -1 },
        { rgb: '55, 95, 245',  w: 50, h: 24, dx: 35,   dy: 1  },
        { rgb: '35, 105, 215', w: 40, h: 22, dx: -35,  dy: 0  },
        { rgb: '50, 90, 230',  w: 35, h: 28, dx: 110,  dy: 1  },
        { rgb: '80, 110, 250', w: 30, h: 30, dx: -110, dy: -1 },
      ],
    },
    /* line inner-perimeter layer: colors are line.dark's, geometry+alpha are
       the original lineInnerGradientData values. */
    lineInner: [
      { a: 0.48, w: 33, h: 30, dx: 0,   dy: 0  },
      { a: 0.42, w: 24, h: 26, dx: 39,  dy: -3 },
      { a: 0.48, w: 27, h: 24, dx: -36, dy: 0  },
      { a: 0.42, w: 23, h: 28, dx: -54, dy: -2 },
      { a: 0.50, w: 24, h: 24, dx: 51,  dy: -1 },
      { a: 0.45, w: 30, h: 20, dx: 21,  dy: 0  },
      { a: 0.40, w: 25, h: 18, dx: -21, dy: -2 },
      { a: 0.45, w: 21, h: 24, dx: 66,  dy: 0  },
      { a: 0.52, w: 18, h: 26, dx: -66, dy: -1 },
    ],
    /* line bloom spike colors (5 fixed spikes at 36/50/64/78/92%). */
    lineSpikes: {
      dark: [
        { rgb: '85, 130, 255', a1: 1,    a2: 1    },
        { rgb: '70, 140, 235', a1: 0.59, a2: 0.29 },
        { rgb: '40, 120, 255', a1: 1,    a2: 1    },
        { rgb: '90, 130, 220', a1: 0.91, a2: 0.45 },
        { rgb: '110, 150, 255', a1: 1,   a2: 1    },
      ],
      light: [
        { rgb: '30, 60, 190',  a1: 1,   a2: 0.8  },
        { rgb: '25, 90, 210',  a1: 0.7, a2: 0.46 },
        { rgb: '15, 70, 200',  a1: 1,   a2: 0.82 },
        { rgb: '45, 100, 195', a1: 1,   a2: 0.7  },
        { rgb: '60, 80, 215',  a1: 1,   a2: 0.78 },
      ],
    },
    /* The two edge spikes at 8% / 22% (primary/secondary spike colors). */
    lineEdgeSpike: {
      dark:  { p: '80, 140, 255', s: '100, 130, 240', sTip: 0.98, pMid: 1,    sMid: 0.49 },
      light: { p: '20, 70, 190',  s: '50, 100, 205',  sTip: 1,    pMid: 0.85, sMid: 0.7  },
    },
  };

  /* ── Pulse geometry tables (verbatim from the original) ── */
  const PULSE_RING_MAP = [
    { r: 1, q: 'tl' }, { r: 2, q: 'tl' }, { r: 3, q: 'bl' },
    { r: 1, q: 'bl' }, { r: 2, q: 'br' }, { r: 3, q: 'br' },
    { r: 1, q: 'tr' }, { r: 2, q: 'tr' }, { r: 3, q: 'tr' },
  ];
  const PULSE_INNER_SIZES = [
    [65, 35], [55, 30], [35, 65], [15, 30], [173, 28], [80, 22], [69, 28], [22, 38], [47, 44],
  ];
  const PULSE_INNER_BLOOM = [
    { ci: 0, w: 84,  h: 48 }, { ci: 1, w: 72,  h: 42 }, { ci: 2, w: 48, h: 84 },
    { ci: 4, w: 216, h: 38 }, { ci: 5, w: 102, h: 31 }, { ci: 6, w: 89, h: 38 },
    { ci: 8, w: 62,  h: 58 },
  ];
  const PULSE_OUTER_CORE = [
    { ci: 0, r: 1, q: 'tl', w: 80, h: 19, x: '27%',  y: '0%'   },
    { ci: 6, r: 2, q: 'tr', w: 74, h: 11, x: '73%',  y: '-1%'  },
    { ci: 7, r: 3, q: 'tr', w: 15, h: 44, x: '100%', y: '33%'  },
    { ci: 8, r: 1, q: 'br', w: 19, h: 38, x: '101%', y: '72%'  },
    { ci: 4, r: 2, q: 'br', w: 84, h: 13, x: '67%',  y: '100%' },
    { ci: 1, r: 3, q: 'bl', w: 60, h: 21, x: '24%',  y: '101%' },
    { ci: 2, r: 1, q: 'bl', w: 17, h: 40, x: '0%',   y: '60%'  },
    { ci: 3, r: 2, q: 'tl', w: 13, h: 32, x: '-1%',  y: '28%'  },
  ];
  const PULSE_OUTER_BLOOM = [
    { ci: 0, w: 110, h: 30, x: '27%',  y: '3%'  },
    { ci: 6, w: 100, h: 20, x: '73%',  y: '1%'  },
    { ci: 7, w: 26,  h: 62, x: '100%', y: '33%' },
    { ci: 8, w: 30,  h: 56, x: '101%', y: '72%' },
    { ci: 4, w: 120, h: 22, x: '67%',  y: '99%' },
    { ci: 1, w: 88,  h: 32, x: '24%',  y: '99%' },
    { ci: 2, w: 28,  h: 58, x: '0%',   y: '60%' },
  ];

  /* Hue drift, re-tuned for a committed blue theme: the original swung ±30°
     (and rotated pulse hues a full 360°, a rainbow). Here the drift stays a
     shimmer WITHIN the blue family. */
  const HUE_RANGE = 12;        /* md/sm ping-pong, ±deg over 12s */
  const LINE_HUE_RANGE = 8;    /* line is capped lower, like the original 13 */
  const PULSE_HUE_RANGE = 14;  /* pulse ping-pongs instead of rotating 360° */

  /* ── Pure oscillator math (port of pulseDriver.ts) ── */
  const TWO_PI = Math.PI * 2;
  /** Cosine ease-in-out ping-pong: 0 at phase 0/1, 1 at phase 0.5. */
  function pingPong(phase) { return (1 - Math.cos(TWO_PI * phase)) / 2; }
  /** Value of one oscillator {a, b, period, delay} at tSec (deterministic). */
  function oscValue(osc, tSec) {
    return osc.a + (osc.b - osc.a) * pingPong((tSec - osc.delay) / osc.period);
  }
  /** Hue ping-pong between -range and +range over period seconds. */
  function hueValue(range, period, tSec) {
    return -range + 2 * range * pingPong(tSec / period);
  }

  /** Theme/duration-tuned breathing parameters (verbatim from the original). */
  function pulseParams(type, theme, duration) {
    const isDark = theme === 'dark';
    const durScale = duration / 2.3;
    if (type === 'pulse-inner') {
      return {
        sp: 0.28, dr: isDark ? 33 : 40, op: isDark ? 0.48 : 0.45,
        gh: isDark ? 0.34 : 0.22,
        bs: (isDark ? 1.9 : 2.6) * durScale,
        ss: (isDark ? 2.6 : 4.6) * durScale,
        ghs: (isDark ? 2.4 : 5.5) * durScale,
        huePeriod: 16,
      };
    }
    return {
      sp: isDark ? 0.28 : 0.36, dr: isDark ? 14 : 19,
      op: isDark ? 0.46 : 0, gh: isDark ? 0.16 : 0.58,
      bs: (isDark ? 2.3 : 3.7) * durScale,
      ss: (isDark ? 6.4 : 4.6) * durScale,
      ghs: (isDark ? 2.4 : 3.8) * durScale,
      huePeriod: 14,
    };
  }

  /** The 17 desynced oscillators of one pulse instance (verbatim table). */
  function oscillatorDefs(id, p) {
    const { sp, dr, op, gh, bs, ss, ghs } = p;
    return [
      { prop: `--fxb-bw1-${id}`, a: 1 - sp,        b: 1 + sp * 1.1,  period: ss * 0.9,  delay: 0,         unit: ''   },
      { prop: `--fxb-bh1-${id}`, a: 1 + sp * 0.9,  b: 1 - sp * 0.85, period: ss * 1.26, delay: 0,         unit: ''   },
      { prop: `--fxb-bx1-${id}`, a: -dr,           b: dr * 0.9,      period: bs * 1.6,  delay: 0,         unit: 'px' },
      { prop: `--fxb-by1-${id}`, a: dr * 0.55,     b: -dr * 0.7,     period: bs * 1.6,  delay: 0,         unit: 'px' },
      { prop: `--fxb-bw2-${id}`, a: 1 + sp,        b: 1 - sp * 0.85, period: ss * 1.1,  delay: 0,         unit: ''   },
      { prop: `--fxb-bh2-${id}`, a: 1 - sp * 0.8,  b: 1 + sp * 1.05, period: ss * 0.81, delay: 0,         unit: ''   },
      { prop: `--fxb-bx2-${id}`, a: dr * 0.8,      b: -dr * 0.9,     period: bs * 1.88, delay: 0,         unit: 'px' },
      { prop: `--fxb-by2-${id}`, a: -dr,           b: dr * 0.65,     period: bs * 1.88, delay: 0,         unit: 'px' },
      { prop: `--fxb-bw3-${id}`, a: 1 - sp * 0.6,  b: 1 + sp * 1.15, period: ss * 0.98, delay: 0,         unit: ''   },
      { prop: `--fxb-bh3-${id}`, a: 1 + sp * 0.75, b: 1 - sp,        period: ss * 1.4,  delay: 0,         unit: ''   },
      { prop: `--fxb-bx3-${id}`, a: -dr * 0.6,     b: dr,            period: bs * 1.45, delay: 0,         unit: 'px' },
      { prop: `--fxb-by3-${id}`, a: -dr * 0.85,    b: dr * 0.45,     period: bs * 1.45, delay: 0,         unit: 'px' },
      { prop: `--fxb-bgh-${id}`, a: 1 - gh,        b: 1 + gh,        period: ghs,       delay: 0,         unit: ''   },
      { prop: `--fxb-bop-tl-${id}`, a: 1 - op, b: 1, period: bs,        delay: 0,         unit: '' },
      { prop: `--fxb-bop-tr-${id}`, a: 1 - op, b: 1, period: bs * 1.32, delay: bs * 0.28, unit: '' },
      { prop: `--fxb-bop-bl-${id}`, a: 1 - op, b: 1, period: bs * 0.84, delay: bs * 0.55, unit: '' },
      { prop: `--fxb-bop-br-${id}`, a: 1 - op, b: 1, period: bs * 1.58, delay: bs * 0.83, unit: '' },
    ];
  }

  /* ── Opts validation ── */
  function normalizeOpts(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const type = o.type === undefined ? 'md' : o.type;
    if (TYPES.indexOf(type) === -1) {
      throw new TypeError(`FxBeam: unknown type "${String(type)}" — expected one of ${TYPES.join(', ')}`);
    }
    const active = o.active === undefined ? true : !!o.active;
    const isPulse = type === 'pulse-inner' || type === 'pulse-outside';
    const defDur = type === 'line' ? 3.1 : isPulse ? 2.3 : 1.96;
    let duration = Number(o.duration);
    if (!Number.isFinite(duration) || duration <= 0) duration = defDur;
    let strength = Number(o.strength);
    if (!Number.isFinite(strength)) strength = 1;
    strength = Math.max(0, Math.min(1, strength));
    /* Per-attach knobs (upstream types.ts:62–162). Each lands on the result
       only when the caller supplied it — an absent key means "the --fxb-*
       token / type constant decides", and the pre-knob call sites keep the
       exact four-key shape they always had. A supplied-but-nonsense scalar
       is dropped rather than repaired to a guess, for the same reason
       duration falls back: the token default is the one honest fallback. */
    const out = { type, active, duration, strength };
    if (o.opacity !== undefined) {
      /* PORT_PLAN: opacity clamps to [0,1] — four upstream presets exceed 1,
         which CSS would clamp silently and differently per property. */
      const v = Number(o.opacity);
      out.opacity = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    }
    if (o.brightness !== undefined) {
      const v = Number(o.brightness);
      if (Number.isFinite(v) && v >= 0) out.brightness = Math.min(3, v);
    }
    if (o.saturation !== undefined) {
      const v = Number(o.saturation);
      if (Number.isFinite(v) && v >= 0) out.saturation = Math.min(3, v);
    }
    if (o.hueRange !== undefined) {
      /* The upstream default (and ceiling) is 30°; the app's committed-blue
         constants sit well under it, and a wider swing would leave the
         family, so the clamp is the palette contract, not just validation. */
      const v = Number(o.hueRange);
      if (Number.isFinite(v)) out.hueRange = Math.max(0, Math.min(30, v));
    }
    if (o.staticColors !== undefined) out.staticColors = !!o.staticColors;
    /* Not an upstream prop: the app's own ambience weight. `bloom: false`
       drops the blurred conic layer entirely (the layer is a child div, so
       this is DOM, not CSS — the shared sheet is unaffected). */
    if (o.bloom !== undefined) out.bloom = !!o.bloom;
    if (o.borderRadius !== undefined) {
      const v = Number(o.borderRadius);
      if (Number.isFinite(v) && v >= 0) out.borderRadius = v;
    }
    if (typeof o.onActivate === 'function') out.onActivate = o.onActivate;
    if (typeof o.onDeactivate === 'function') out.onDeactivate = o.onDeactivate;
    return out;
  }

  /* ── CSS generation ─────────────────────────────────────────────────────
     One rule block per instance, injected as its own <style> tag (no id —
     tagged data-fxbeam-style). Scalar tuning comes from the --fxb-* tokens
     in the styles block, so md/sm output is theme-agnostic; line and pulse
     are theme-resolved and regenerate when data-theme flips. When `reduced`
     is true no animation properties or keyframes are emitted at all — the
     layers hold a static subtle glow, and JS sets the opacity var directly. */

  const gradEllipse = (w, h, x, y, color) =>
    `radial-gradient(ellipse ${w}px ${h}px at ${x} ${y}, ${color}, transparent)`;

  /** Theme-flipping shine stop: white on dark, black on light, alpha scaled
      by the --fxb-shine-a token (the original's light alphas ≈ dark × .73). */
  const shine = (a) => `rgba(var(--fxb-shine), calc(${a} * var(--fxb-shine-a, 1)))`;

  function shineConic(id) {
    return `conic-gradient(from var(--fxb-a-${id}), transparent 0%, transparent 54%, ${shine(0.1)} 57%, ${shine(0.3)} 60%, ${shine(0.6)} 63%, ${shine(0.75)} 66%, ${shine(0.6)} 69%, ${shine(0.3)} 72%, ${shine(0.1)} 75%, transparent 78%, transparent 100%)`;
  }
  function bloomConic(id) {
    return `conic-gradient(from var(--fxb-a-${id}), transparent 0%, transparent 58%, ${shine(0.03)} 62%, ${shine(0.08)} 65%, ${shine(0.2)} 67%, ${shine(0.45)} 69%, ${shine(0.85)} 70%, ${shine(0.85)} 70.5%, ${shine(0.45)} 71.5%, ${shine(0.2)} 73%, ${shine(0.08)} 75%, ${shine(0.03)} 78%, transparent 82%)`;
  }

  /* The rotating window masks are alpha-only, identical in both themes. */
  function windowMask(id) {
    return `conic-gradient(from var(--fxb-a-${id}), transparent 0%, transparent 30%, rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%, white 52%, white 80%, rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%, transparent 95%, transparent 100%)`;
  }
  function smallWindowMask(id) {
    return `conic-gradient(from var(--fxb-a-${id}), transparent 0%, transparent 22%, rgba(255, 255, 255, 0.12) 28%, rgba(255, 255, 255, 0.4) 36%, white 46%, white 82%, rgba(255, 255, 255, 0.4) 88%, rgba(255, 255, 255, 0.12) 94%, transparent 97%, transparent 100%)`;
  }
  const RING_MASK = 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)';
  const EDGE_FRAME_MASK = 'linear-gradient(white, transparent 28px, transparent calc(100% - 28px), white), linear-gradient(to right, white, transparent 28px, transparent calc(100% - 28px), white)';

  function borderGradients() {
    return PALETTE.border.map(c => gradEllipse(c.w, c.h, c.x, c.y, `rgb(${c.rgb})`)).join(', ');
  }
  function borderInnerGradients() {
    return PALETTE.border
      .map(c => gradEllipse(Math.round(c.w * 0.9), Math.round(c.h * 0.9), c.x, c.y, `rgba(${c.rgb}, 0.45)`))
      .join(', ');
  }
  function smallGradients() {
    return PALETTE.small.map(c => gradEllipse(c.w, c.h, c.x, c.y, `rgb(${c.rgb})`)).join(', ');
  }
  function smallInnerGradients() {
    return PALETTE.small
      .map((c, i) => gradEllipse(c.w, c.h, c.x, c.y, `rgba(${c.rgb}, ${PALETTE.smallInnerAlphas[i]})`))
      .join(', ');
  }

  function baseRegs(id) {
    return `@property --fxb-a-${id} { syntax: "<angle>"; initial-value: 0deg; inherits: true; }
@property --fxb-o-${id} { syntax: "<number>"; initial-value: 0; inherits: true; }`;
  }

  function fadeKeyframes(id) {
    return `@keyframes fxb-fade-in-${id} { to { --fxb-o-${id}: 1; } }
@keyframes fxb-fade-out-${id} { from { --fxb-o-${id}: 1; } to { --fxb-o-${id}: 0; } }`;
  }

  function pausedRule(id) {
    return `[data-fxbeam="${id}"][data-fxbeam-paused],
[data-fxbeam="${id}"][data-fxbeam-paused]::after,
[data-fxbeam="${id}"][data-fxbeam-paused]::before,
[data-fxbeam="${id}"][data-fxbeam-paused] > [data-fxbeam-bloom] {
  animation-play-state: paused !important;
}`;
  }

  function hueKeyframes(id, range, tok) {
    return `@keyframes fxb-hue-${id} {
  0%, 100% { filter: hue-rotate(-${range}deg) brightness(var(--fxb-${tok}-bright, 1.3)) saturate(var(--fxb-${tok}-sat, 1.2)); }
  50% { filter: hue-rotate(${range}deg) brightness(var(--fxb-${tok}-bright, 1.3)) saturate(var(--fxb-${tok}-sat, 1.2)); }
}`;
  }

  const opacityCalc = (id, tok, layer) =>
    `calc(var(--fxb-o-${id}) * var(--fxb-${tok}-${layer}, 1) * var(--fxb-strength, 1))`;

  /* md — full ring: rotating shine + colored ring (::after), masked inner
     wash (::before), blurred conic bloom (child div). */
  function buildRotateCSS(id, type, duration, radius, reduced, hueRange, staticColors) {
    const sm = type === 'sm';
    const tok = sm ? 'sm' : 'md';
    const innerR = Math.max(0, radius - 1);
    const hr = hueRange === undefined ? HUE_RANGE : hueRange;
    /* staticColors pins the hue but must keep the brightness/saturation the
       drifting filter otherwise carried — a bare "no animation" would also
       silently drop both tokens. reduced keeps its established no-filter
       degrade untouched. */
    const anim = reduced ? ''
      : staticColors ? `\n  filter: brightness(var(--fxb-${tok}-bright, 1.3)) saturate(var(--fxb-${tok}-sat, 1.2));`
      : `\n  animation: fxb-hue-${id} 12s ease-in-out infinite;`;
    const wrapperAnim = (fade) => reduced ? '' :
      `\n  animation: fxb-spin-${id} ${duration}s linear infinite, fxb-${fade}-${id} ${fade === 'fade-in' ? '0.6' : '0.5'}s ease forwards;`;
    const colorG = sm ? smallGradients() : borderGradients();
    const innerG = sm ? smallInnerGradients() : borderInnerGradients();
    const afterMask = `${windowMask(id)}, ${RING_MASK}`;
    const beforeMask = sm
      ? smallWindowMask(id)
      : `${windowMask(id)}, ${EDGE_FRAME_MASK}`;
    const beforeComposite = sm ? 'add' : 'intersect, add';
    const beforeWebkitComposite = sm ? 'source-over' : 'source-in, source-over';
    const shadowSpread = sm ? '5px 1px' : '9px 1px';
    /* No per-instance `position`: the shared `[data-fxbeam]` base rule owns it
       at class specificity, so a host laid out deliberately (an absolutely
       positioned .fx-beam-strip overlay) still wins. Repeating it here would
       outrank that from a later sheet and pull the overlay back into flow. */
    return `${baseRegs(id)}
[data-fxbeam="${id}"][data-fxbeam-on] {${wrapperAnim('fade-in') || ' /* reduced: static */'}
  border-radius: ${radius}px;
  overflow: hidden;
}
[data-fxbeam="${id}"][data-fxbeam-fading] {${wrapperAnim('fade-out')}
  border-radius: ${radius}px;
  overflow: hidden;
}
[data-fxbeam="${id}"][data-fxbeam-on]::after,
[data-fxbeam="${id}"][data-fxbeam-fading]::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: ${innerR}px;
  padding: 1px;
  clip-path: inset(0 round ${radius}px);
  background: ${shineConic(id)}, ${colorG};
  -webkit-mask: ${afterMask};
  -webkit-mask-composite: source-in, xor;
  mask: ${afterMask};
  mask-composite: intersect, exclude;
  pointer-events: none;
  z-index: 2;
  opacity: ${opacityCalc(id, tok, 'stroke')};${anim}
}
[data-fxbeam="${id}"][data-fxbeam-on]::before,
[data-fxbeam="${id}"][data-fxbeam-fading]::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: ${radius}px;
  clip-path: inset(0 round ${radius}px);
  background: ${innerG};
  box-shadow: inset 0 0 ${shadowSpread} var(--fxb-${tok}-shadow, rgba(255, 255, 255, 0.27));
  -webkit-mask-image: ${beforeMask};
  -webkit-mask-composite: ${beforeWebkitComposite};
  mask-image: ${beforeMask};
  mask-composite: ${beforeComposite};
  pointer-events: none;
  z-index: 1;
  opacity: ${opacityCalc(id, tok, 'inner')};${anim}
}
[data-fxbeam="${id}"] > [data-fxbeam-bloom] {
  border-radius: ${innerR}px;
  clip-path: inset(0 round ${radius}px);
  inset: 0;
  background: ${bloomConic(id)};
  -webkit-mask: ${RING_MASK};
  -webkit-mask-composite: xor;
  mask: ${RING_MASK};
  mask-composite: exclude;
  padding: 1px;
  filter: blur(8px) brightness(var(--fxb-${tok}-bright, 1.3)) saturate(var(--fxb-${tok}-sat, 1.2));
  z-index: 3;
  opacity: 0;
}
[data-fxbeam="${id}"][data-fxbeam-on] > [data-fxbeam-bloom],
[data-fxbeam="${id}"][data-fxbeam-fading] > [data-fxbeam-bloom] {
  display: block;
  opacity: ${opacityCalc(id, tok, 'bloom')};
}
${reduced ? '' : `@keyframes fxb-spin-${id} { to { --fxb-a-${id}: 360deg; } }
${fadeKeyframes(id)}
${staticColors ? '' : hueKeyframes(id, hr, tok)}
${pausedRule(id)}`}`;
  }

  /* line — bottom traveling glow with breathe + spike oscillators. Theme-
     resolved: the palettes' geometry differs per theme. */
  function lineGrads(entries, id, alphas) {
    return entries.map((c, i) => {
      const ox = c.dx === 0 ? '' : (c.dx > 0 ? ` + ${c.dx}px` : ` - ${-c.dx}px`);
      const oy = c.dy === 0 ? '' : (c.dy > 0 ? ` + ${c.dy}px` : ` - ${-c.dy}px`);
      const color = alphas ? `rgba(${c.rgb}, ${alphas[i]})` : `rgb(${c.rgb})`;
      return `radial-gradient(ellipse calc(${c.w}px * var(--fxb-w-${id})) calc(${c.h}px * var(--fxb-h-${id})) at calc(var(--fxb-x-${id}) * 100%${ox}) calc(100%${oy}), ${color}, transparent)`;
    }).join(', ');
  }

  function lineBloomGradients(id, isDark) {
    const es = PALETTE.lineEdgeSpike[isDark ? 'dark' : 'light'];
    const sp = PALETTE.lineSpikes[isDark ? 'dark' : 'light'];
    const a = (rgb, al) => `rgba(${rgb}, ${al})`;
    const sc1 = a(es.p, 1);
    const sc1mid = a(es.p, es.pMid);
    const sc2 = a(es.s, es.sTip);
    const sc2mid = a(es.s, es.sMid);
    const spike = (i, sizeExpr, at, midPct, endPct) =>
      `radial-gradient(ellipse ${sizeExpr} at ${at}, ${a(sp[i].rgb, sp[i].a1)}, ${a(sp[i].rgb, sp[i].a2)} ${midPct}%, transparent ${endPct}%)`;
    const parts = [
      `radial-gradient(ellipse calc(0.8px * var(--fxb-spike-${id})) calc(92px * var(--fxb-h-${id})) at 8% calc(100% - 2px), ${sc1}, ${sc1mid} 30%, transparent 88%)`,
      `radial-gradient(ellipse calc(10px * var(--fxb-spike2-${id})) calc(35px * var(--fxb-h-${id})) at 22% calc(100% - 4px), ${sc2}, ${sc2mid} 50%, transparent 95%)`,
      spike(0, `calc(2px * (2 - var(--fxb-spike-${id}))) calc(72px * var(--fxb-h-${id}))`, `36% calc(100% - 3px)`, 40, 90),
      spike(1, `calc(14px * var(--fxb-spike2-${id})) calc(28px * var(--fxb-h-${id}))`, `50% calc(100% - 2px)`, 55, 96),
      spike(2, `calc(1.2px * (2 - var(--fxb-spike2-${id}))) calc(85px * var(--fxb-h-${id}))`, `64% calc(100% - 4px)`, 35, 89),
      spike(3, `calc(7px * var(--fxb-spike-${id})) calc(45px * var(--fxb-h-${id}))`, `78% calc(100% - 2px)`, 48, 94),
      spike(4, `calc(${isDark ? '0.6px' : '1px'} * (2 - var(--fxb-spike-${id}))) calc(60px * var(--fxb-h-${id}))`, `92% calc(100% - 3px)`, 42, 91),
    ];
    if (isDark) {
      parts.push(
        `radial-gradient(ellipse calc(21px * var(--fxb-spike-${id})) calc(15px * var(--fxb-spike2-${id})) at calc(var(--fxb-x-${id}) * 100%) calc(100% + 1px), rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0.9) 20%, rgba(255, 255, 255, 0.5) 50%, transparent 100%)`,
        `radial-gradient(ellipse calc(42px * var(--fxb-w-${id})) calc(40px * var(--fxb-h-${id})) at calc(var(--fxb-x-${id}) * 100%) 100%, rgba(255, 255, 255, 0.3) 0%, rgba(255, 255, 255, 0.12) 25%, rgba(255, 255, 255, 0.03) 55%, transparent 80%)`
      );
    } else {
      parts.push(
        `radial-gradient(ellipse calc(50px * var(--fxb-w-${id})) calc(32px * var(--fxb-h-${id})) at calc(var(--fxb-x-${id}) * 100%) calc(100%), rgba(0, 0, 0, 0.5) 0%, rgba(0, 0, 0, 0.18) 30%, rgba(0, 0, 0, 0.03) 60%, transparent 85%)`
      );
    }
    return parts.join(', ');
  }

  function buildLineCSS(id, theme, duration, radius, reduced, hueRange, staticColors) {
    const isDark = theme === 'dark';
    const innerR = Math.max(0, radius - 1);
    const entries = PALETTE.line[isDark ? 'dark' : 'light'];
    const innerEntries = PALETTE.lineInner.map((g, i) => ({ rgb: PALETTE.line.dark[i].rgb, w: g.w, h: g.h, dx: g.dx, dy: g.dy }));
    const innerAlphas = PALETTE.lineInner.map(g => g.a);
    const hr = hueRange === undefined ? LINE_HUE_RANGE : hueRange;
    /* staticColors: the travel/breathe/spike oscillators keep running — only
       the hue drift freezes, holding the same brightness/saturation the
       drifting filter carried. */
    const anim = reduced ? ''
      : staticColors ? `\n  filter: brightness(var(--fxb-line-bright, 1.3)) saturate(var(--fxb-line-sat, 1.2));`
      : `\n  animation: fxb-hue-${id} 12s ease-in-out infinite;`;
    const bloomAnim = reduced || staticColors
      ? `\n  filter: blur(8px) brightness(var(--fxb-line-bright, 1.3)) saturate(var(--fxb-line-sat, 1.2));`
      : `\n  animation: fxb-hue-bloom-${id} 8s ease-in-out infinite;`;
    const wrapperAnim = (fade) => reduced ? '' : `
  animation:
    fxb-travel-${id} ${duration}s linear infinite,
    fxb-edge-${id} ${duration}s linear infinite,
    fxb-breathe-${id} ${(duration * 1.3).toFixed(1)}s ease-in-out infinite,
    fxb-spike-${id} ${(duration * 1.33).toFixed(1)}s ease-in-out infinite,
    fxb-spike2-${id} ${(duration * 1.7).toFixed(1)}s ease-in-out infinite,
    fxb-${fade}-${id} ${fade === 'fade-in' ? '0.6' : '0.5'}s ease forwards;`;
    const whiteHighlight = isDark
      ? `radial-gradient(ellipse calc(24px * var(--fxb-w-${id})) calc(28px * var(--fxb-h-${id})) at calc(var(--fxb-x-${id}) * 100%) calc(100% + 2px), rgba(255, 255, 255, 0.38) 0%, rgba(255, 255, 255, 0.12) 30%, transparent 65%)`
      : `radial-gradient(ellipse calc(35px * var(--fxb-w-${id})) calc(28px * var(--fxb-h-${id})) at calc(var(--fxb-x-${id}) * 100%) calc(100% + 2px), rgba(0, 0, 0, 0.6) 0%, rgba(0, 0, 0, 0.25) 35%, transparent 70%)`;
    const travelMask = `radial-gradient(ellipse calc(78px * var(--fxb-w-${id})) calc(60px * var(--fxb-h-${id})) at calc(var(--fxb-x-${id}) * 100%) 100%, white 0%, rgba(255, 255, 255, 0.5) 45%, transparent 100%)`;
    const bloomMask = `radial-gradient(ellipse calc(84px * var(--fxb-w-${id})) calc(110px * var(--fxb-h-${id})) at calc(var(--fxb-x-${id}) * 100%) 100%, white 0%, rgba(255, 255, 255, 0.5) 35%, transparent 100%)`;
    const numProps = ['x', 'w', 'h', 'spike', 'spike2', 'edge'];
    const regs = numProps
      .map(n => `@property --fxb-${n}-${id} { syntax: "<number>"; initial-value: ${n === 'x' ? 0 : 1}; inherits: true; }`)
      .join('\n');
    return `${regs}
@property --fxb-o-${id} { syntax: "<number>"; initial-value: 0; inherits: true; }
[data-fxbeam="${id}"][data-fxbeam-on] {${wrapperAnim('fade-in') || ' /* reduced: static */'}
  border-radius: ${radius}px;
  overflow: hidden;
}
[data-fxbeam="${id}"][data-fxbeam-fading] {${wrapperAnim('fade-out')}
  border-radius: ${radius}px;
  overflow: hidden;
}
[data-fxbeam="${id}"][data-fxbeam-on]::after,
[data-fxbeam="${id}"][data-fxbeam-fading]::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: ${innerR}px;
  padding: 1px;
  clip-path: inset(0 round ${radius}px);
  background: ${whiteHighlight}, ${lineGrads(entries, id, null)};
  -webkit-mask: ${travelMask}, ${RING_MASK};
  -webkit-mask-composite: source-in, xor;
  mask: ${travelMask}, ${RING_MASK};
  mask-composite: intersect, exclude;
  pointer-events: none;
  z-index: 2;
  opacity: calc(var(--fxb-o-${id}) * var(--fxb-edge-${id}) * var(--fxb-line-stroke, 1) * var(--fxb-strength, 1));${anim}
}
[data-fxbeam="${id}"][data-fxbeam-on]::before,
[data-fxbeam="${id}"][data-fxbeam-fading]::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: ${radius}px;
  clip-path: inset(0 round ${radius}px);
  background: ${lineGrads(innerEntries, id, innerAlphas)};
  box-shadow: inset 0 0 9px 1px var(--fxb-line-shadow, rgba(255, 255, 255, 0.1));
  -webkit-mask-image: ${travelMask}, ${EDGE_FRAME_MASK};
  -webkit-mask-composite: source-in, source-over;
  mask-image: ${travelMask}, ${EDGE_FRAME_MASK};
  mask-composite: intersect, add;
  pointer-events: none;
  z-index: 1;
  opacity: calc(var(--fxb-o-${id}) * var(--fxb-edge-${id}) * var(--fxb-line-inner, 1) * var(--fxb-strength, 1));${anim}
}
[data-fxbeam="${id}"] > [data-fxbeam-bloom] {
  inset: 0;
  border-radius: ${innerR}px;
  clip-path: inset(0 round ${radius}px);
  -webkit-mask: ${bloomMask};
  mask: ${bloomMask};
  background: ${lineBloomGradients(id, isDark)};
  z-index: 3;
  opacity: 0;
}
[data-fxbeam="${id}"][data-fxbeam-on] > [data-fxbeam-bloom],
[data-fxbeam="${id}"][data-fxbeam-fading] > [data-fxbeam-bloom] {
  display: block;
  opacity: calc(var(--fxb-o-${id}) * var(--fxb-edge-${id}) * var(--fxb-line-bloom, 1) * var(--fxb-strength, 1));${bloomAnim}
}
${reduced ? '' : `@keyframes fxb-travel-${id} {
  0%   { --fxb-x-${id}: 0.06; --fxb-w-${id}: 0.5; }
  10%  { --fxb-x-${id}: 0.15; --fxb-w-${id}: 0.8; }
  20%  { --fxb-x-${id}: 0.25; --fxb-w-${id}: 1.1; }
  30%  { --fxb-x-${id}: 0.35; --fxb-w-${id}: 1.3; }
  40%  { --fxb-x-${id}: 0.44; --fxb-w-${id}: 1.45; }
  50%  { --fxb-x-${id}: 0.5;  --fxb-w-${id}: 1.5; }
  60%  { --fxb-x-${id}: 0.56; --fxb-w-${id}: 1.45; }
  70%  { --fxb-x-${id}: 0.65; --fxb-w-${id}: 1.3; }
  80%  { --fxb-x-${id}: 0.75; --fxb-w-${id}: 1.1; }
  90%  { --fxb-x-${id}: 0.85; --fxb-w-${id}: 0.8; }
  100% { --fxb-x-${id}: 0.94; --fxb-w-${id}: 0.5; }
}
@keyframes fxb-edge-${id} {
  0%    { --fxb-edge-${id}: 0; }
  12.5% { --fxb-edge-${id}: 0; }
  32.5% { --fxb-edge-${id}: 1; }
  67.5% { --fxb-edge-${id}: 1; }
  87.5% { --fxb-edge-${id}: 0; }
  100%  { --fxb-edge-${id}: 0; }
}
@keyframes fxb-breathe-${id} {
  0%, 100% { --fxb-h-${id}: 0.8; }
  25%      { --fxb-h-${id}: 1.25; }
  55%      { --fxb-h-${id}: 0.85; }
  80%      { --fxb-h-${id}: 1.3; }
}
@keyframes fxb-spike-${id} {
  0%   { --fxb-spike-${id}: 0.8; }
  25%  { --fxb-spike-${id}: 1.3; }
  50%  { --fxb-spike-${id}: 0.9; }
  75%  { --fxb-spike-${id}: 1.4; }
  100% { --fxb-spike-${id}: 0.8; }
}
@keyframes fxb-spike2-${id} {
  0%   { --fxb-spike2-${id}: 1.2; }
  25%  { --fxb-spike2-${id}: 0.7; }
  50%  { --fxb-spike2-${id}: 1.4; }
  75%  { --fxb-spike2-${id}: 0.8; }
  100% { --fxb-spike2-${id}: 1.2; }
}
${fadeKeyframes(id)}
${staticColors ? '' : `@keyframes fxb-hue-${id} {
  0%, 100% { filter: hue-rotate(-${hr}deg) brightness(var(--fxb-line-bright, 1.3)) saturate(var(--fxb-line-sat, 1.2)); }
  50% { filter: hue-rotate(${hr}deg) brightness(var(--fxb-line-bright, 1.3)) saturate(var(--fxb-line-sat, 1.2)); }
}
@keyframes fxb-hue-bloom-${id} {
  0%, 100% { filter: blur(8px) hue-rotate(-${hr + 10}deg) brightness(var(--fxb-line-bright, 1.3)) saturate(var(--fxb-line-sat, 1.2)); }
  50% { filter: blur(8px) hue-rotate(${hr + 10}deg) brightness(var(--fxb-line-bright, 1.3)) saturate(var(--fxb-line-sat, 1.2)); }
}`}
${pausedRule(id)}`}`;
  }

  /* ── Pulse CSS ── */
  function pulseRegs(id) {
    const numbers = ['bw1', 'bh1', 'bw2', 'bh2', 'bw3', 'bh3', 'bgh', 'bop-tl', 'bop-tr', 'bop-bl', 'bop-br'];
    const lengths = ['bx1', 'by1', 'bx2', 'by2', 'bx3', 'by3'];
    return numbers.map(n => `@property --fxb-${n}-${id} { syntax: "<number>"; initial-value: 1; inherits: true; }`).join('\n')
      + '\n' + lengths.map(n => `@property --fxb-${n}-${id} { syntax: "<length>"; initial-value: 0px; inherits: true; }`).join('\n')
      + `\n@property --fxb-o-${id} { syntax: "<number>"; initial-value: 0; inherits: true; }`
      + `\n@property --fxb-hue-${id} { syntax: "<angle>"; initial-value: 0deg; inherits: true; }`;
  }

  function pulseGrad(rgb, w, h, region, quad, x, y, id) {
    return `radial-gradient(ellipse calc(${w}px * var(--fxb-bw${region}-${id}) * var(--fxb-sx, 1)) calc(${h}px * var(--fxb-bh${region}-${id}) * var(--fxb-bgh-${id}) * var(--fxb-sy, 1)) at calc(${x} + var(--fxb-bx${region}-${id})) calc(${y} + var(--fxb-by${region}-${id})), rgba(${rgb}, var(--fxb-bop-${quad}-${id})), transparent)`;
  }

  function pulseRingGradients(id) {
    return PALETTE.border.map((c, i) => {
      const { r, q } = PULSE_RING_MAP[i];
      return pulseGrad(c.rgb, c.w, c.h, r, q, c.x, c.y, id);
    }).join(', ');
  }

  function pulseInnerGradients(id, isDark) {
    const grads = PALETTE.border.map((c, i) => {
      const { r, q } = PULSE_RING_MAP[i];
      const [w, h] = PULSE_INNER_SIZES[i];
      return pulseGrad(c.rgb, w, h, r, q, c.x, c.y, id);
    });
    const cornerRGB = isDark ? '255, 255, 255' : '0, 0, 0';
    const cornerAlpha = isDark ? 0.18 : 0.08;
    const corners = [['0%', '0%', 'tl'], ['100%', '0%', 'tr'], ['0%', '100%', 'bl'], ['100%', '100%', 'br']];
    for (const [x, y, q] of corners) {
      grads.push(`radial-gradient(ellipse 60px 60px at ${x} ${y}, rgba(${cornerRGB}, calc(${cornerAlpha} * var(--fxb-bop-${q}-${id}))), transparent 70%)`);
    }
    return grads.join(', ');
  }

  function pulseCoreGradients(id) {
    return PULSE_OUTER_CORE.map(e => {
      const c = PALETTE.border[e.ci];
      return pulseGrad(c.rgb, e.w, e.h, e.r, e.q, e.x, e.y, id);
    }).join(', ');
  }

  /* Frozen bloom: literal alpha at the breathing time-average, so the
     heavily-blurred bitmap is painted once and cached by the compositor
     (the single biggest per-frame saving in the original 1.2 rewrite). */
  function pulseBloomStatic(table, frozenAlpha) {
    const a = +frozenAlpha.toFixed(3);
    return table.map(e => {
      const c = PALETTE.border[e.ci];
      const x = e.x !== undefined ? e.x : c.x;
      const y = e.y !== undefined ? e.y : c.y;
      return `radial-gradient(ellipse calc(${e.w}px * var(--fxb-sx, 1)) calc(${e.h}px * var(--fxb-sy, 1)) at ${x} ${y}, rgba(${c.rgb}, ${a}), transparent)`;
    }).join(', ');
  }

  function buildPulseCSS(id, type, theme, duration, radius, reduced, staticColors) {
    const isDark = theme === 'dark';
    const outside = type === 'pulse-outside';
    const tok = outside ? 'po' : 'pi';
    const { op } = pulseParams(type, theme, duration);
    /* Pulse hue lives on the shared driver, not in keyframes — staticColors
       drops the hue-rotate() term here and rebuild() withholds the driver's
       hue config, so the breathing oscillators keep running untouched. */
    const hueFilter = reduced || staticColors ? '' : `hue-rotate(var(--fxb-hue-${id})) `;
    const bs = `brightness(var(--fxb-${tok}-bright, 1)) saturate(var(--fxb-${tok}-sat, 1.2))`;
    const ringAnim = `filter: ${hueFilter}${bs};`;
    const bloomBlurVar = outside ? `var(--fxb-po-bloom-blur, 22.5px)` : '8px';
    const coreBlurVar = `var(--fxb-po-core-blur, 3px)`;
    const bloomAnim = `filter: blur(${bloomBlurVar}) ${hueFilter}${bs};`;
    const coreAnim = `filter: blur(${coreBlurVar}) ${hueFilter}${bs};`;
    const wrapperAnim = (fade) => reduced ? '' : `\n  animation: fxb-${fade}-${id} ${fade === 'fade-in' ? '0.6' : '0.5'}s ease forwards;`;
    const bloomG = pulseBloomStatic(outside ? PULSE_OUTER_BLOOM : PULSE_INNER_BLOOM, 1 - op * 0.5);
    /* pulse-outside outward-glow constants, ported from the v5 c6 defaults. */
    const sw = 0.95, shScale = 0.9;
    if (outside) {
      return `${pulseRegs(id)}
[data-fxbeam="${id}"] {
  border-radius: ${radius}px;
  overflow: visible;
  isolation: isolate;
}
[data-fxbeam="${id}"][data-fxbeam-on] {${wrapperAnim('fade-in') || ' /* reduced: static */'}
}
[data-fxbeam="${id}"][data-fxbeam-fading] {${wrapperAnim('fade-out')}
}
[data-fxbeam="${id}"][data-fxbeam-on]::after,
[data-fxbeam="${id}"][data-fxbeam-fading]::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: ${radius}px;
  padding: 1px;
  clip-path: inset(0 round ${radius}px);
  background: ${pulseCoreGradients(id)};
  -webkit-mask: ${RING_MASK};
  -webkit-mask-composite: xor;
  mask: ${RING_MASK};
  mask-composite: exclude;
  pointer-events: none;
  z-index: 2;
  will-change: opacity, filter;
  opacity: ${opacityCalc(id, tok, 'stroke')};
  ${ringAnim}
}
[data-fxbeam="${id}"][data-fxbeam-on]::before,
[data-fxbeam="${id}"][data-fxbeam-fading]::before {
  content: "";
  position: absolute;
  inset: -10px;
  z-index: -1;
  border-radius: ${radius + 10}px;
  background: ${pulseCoreGradients(id)};
  transform: scale(${sw}, ${shScale});
  pointer-events: none;
  will-change: opacity, filter;
  opacity: ${opacityCalc(id, tok, 'inner')};
  ${coreAnim}
}
[data-fxbeam="${id}"] > [data-fxbeam-bloom] {
  inset: -30px;
  z-index: -1;
  border-radius: ${radius + 30}px;
  background: ${bloomG};
  transform: scale(${sw}, ${shScale});
  will-change: transform;
  opacity: 0;
}
[data-fxbeam="${id}"][data-fxbeam-on] > [data-fxbeam-bloom],
[data-fxbeam="${id}"][data-fxbeam-fading] > [data-fxbeam-bloom] {
  display: block;
  opacity: ${opacityCalc(id, tok, 'bloom')};
  ${bloomAnim}
}
${reduced ? '' : `${fadeKeyframes(id)}
${pausedRule(id)}`}`;
    }
    return `${pulseRegs(id)}
[data-fxbeam="${id}"] {
  isolation: isolate;
}
[data-fxbeam="${id}"][data-fxbeam-on] {${wrapperAnim('fade-in') || ' /* reduced: static */'}
  border-radius: ${radius}px;
  overflow: hidden;
}
[data-fxbeam="${id}"][data-fxbeam-fading] {${wrapperAnim('fade-out')}
  border-radius: ${radius}px;
  overflow: hidden;
}
[data-fxbeam="${id}"][data-fxbeam-on]::after,
[data-fxbeam="${id}"][data-fxbeam-fading]::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: ${radius}px;
  padding: 1px;
  clip-path: inset(0 round ${radius}px);
  background: ${pulseRingGradients(id)};
  -webkit-mask: ${RING_MASK};
  -webkit-mask-composite: xor;
  mask: ${RING_MASK};
  mask-composite: exclude;
  pointer-events: none;
  z-index: 2;
  will-change: opacity, filter;
  opacity: ${opacityCalc(id, tok, 'stroke')};
  ${ringAnim}
}
[data-fxbeam="${id}"][data-fxbeam-on]::before,
[data-fxbeam="${id}"][data-fxbeam-fading]::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: ${radius}px;
  clip-path: inset(0 round ${radius}px);
  background: ${pulseInnerGradients(id, isDark)};
  -webkit-mask-image: ${EDGE_FRAME_MASK};
  -webkit-mask-composite: source-over;
  mask-image: ${EDGE_FRAME_MASK};
  mask-composite: add;
  pointer-events: none;
  z-index: 1;
  will-change: opacity, filter;
  opacity: ${opacityCalc(id, tok, 'inner')};
  ${ringAnim}
}
[data-fxbeam="${id}"] > [data-fxbeam-bloom] {
  inset: 0;
  border-radius: ${radius}px;
  clip-path: inset(0 round ${radius}px);
  background: ${bloomG};
  -webkit-mask: ${RING_MASK};
  -webkit-mask-composite: xor;
  mask: ${RING_MASK};
  mask-composite: exclude;
  padding: 1px;
  z-index: 3;
  will-change: opacity;
  opacity: 0;
}
[data-fxbeam="${id}"][data-fxbeam-on] > [data-fxbeam-bloom],
[data-fxbeam="${id}"][data-fxbeam-fading] > [data-fxbeam-bloom] {
  display: block;
  opacity: ${opacityCalc(id, tok, 'bloom')};
  ${bloomAnim}
}
${reduced ? '' : `${fadeKeyframes(id)}
${pausedRule(id)}`}`;
  }

  /** Complete per-instance CSS for a type × theme (pure — safe to unit test).
      Host mutations (overflow:hidden, the uniform border-radius override)
      live on the LIT selectors only: an attached-but-dark beam must leave
      its host exactly as found — an idle base rule that clips children or
      rewrites corner radii is a latent bug for every future tooltip or
      badge on that host. Only the pulse types' isolation stays
      unconditional. pulse-outside keeps its overflow:visible base — it
      never clipped anything to begin with. `position` is NOT emitted here
      at all: the shared `[data-fxbeam]` base rule sets it at class
      specificity so a host with a deliberate layout (an absolutely
      positioned .fx-beam-strip overlay) can still override it. */
  function buildCSS(id, type, theme, duration, radius, reduced, knobs) {
    /* `knobs` is the optional per-attach bag — {hueRange, staticColors}.
       Omitting it (every pre-knob caller, the extraction tests' 6-arg calls)
       must produce byte-identical CSS to passing both as undefined. */
    const k = knobs || {};
    if (type === 'line') return buildLineCSS(id, theme, duration, radius, reduced, k.hueRange, k.staticColors);
    if (type === 'pulse-inner' || type === 'pulse-outside') return buildPulseCSS(id, type, theme, duration, radius, reduced, k.staticColors);
    return buildRotateCSS(id, type, duration, radius, reduced, k.hueRange, k.staticColors);
  }

  /* ── Shared ~30fps pulse driver (port of pulseDriver.ts) ── */
  const driven = new Set();
  let rafId = null;
  let lastFrame = 0;
  const FRAME_INTERVAL = 1000 / 30 - 2;

  function driverFrame(ts) {
    rafId = requestAnimationFrame(driverFrame);
    if (document.hidden) return;
    if (ts - lastFrame < FRAME_INTERVAL) return;
    lastFrame = ts;
    const tSec = ts / 1000;
    driven.forEach((inst) => {
      const cfg = inst.driverCfg;
      for (const osc of cfg.oscillators) {
        const value = oscValue(osc, tSec);
        inst.el.style.setProperty(osc.prop, osc.unit === 'px' ? `${value.toFixed(2)}px` : value.toFixed(4));
      }
      if (cfg.hue) {
        inst.el.style.setProperty(cfg.hue.prop, `${hueValue(cfg.hue.range, cfg.hue.period, tSec).toFixed(2)}deg`);
      }
    });
  }
  function driverStart() {
    if (rafId == null) { lastFrame = 0; rafId = requestAnimationFrame(driverFrame); }
  }
  function driverStopIfIdle() {
    if (driven.size === 0 && rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  /* ── Instance registry + lifecycle ── */
  const registry = new Map();
  let seq = 0;
  let wired = false;
  let io = null;
  let ro = null;

  function resolveTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function detectRadius(el, type) {
    let r = NaN;
    try { r = parseFloat(getComputedStyle(el).borderTopLeftRadius); } catch { /* detached */ }
    if (!Number.isFinite(r) || r < 0) r = NaN;
    if (Number.isNaN(r) || r === 0) r = type === 'sm' ? 10 : 13; /* app --r-sm / --r-md */
    return r;
  }

  function ensureWiring() {
    if (wired) return;
    wired = true;
    document.addEventListener('visibilitychange', () => {
      registry.forEach((inst) => { syncPaused(inst); syncDriver(inst); });
    });
    /* Theme flips: md/sm CSS is token-driven and needs nothing; line and
       pulse have theme-resolved structure, so rebuild those. */
    const mo = new MutationObserver(() => {
      registry.forEach((inst) => {
        if (inst.cfg.type !== 'md' && inst.cfg.type !== 'sm') rebuild(inst);
      });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const inst = registry.get(entry.target);
          if (!inst) continue;
          inst.visible = entry.isIntersecting;
          syncPaused(inst); syncDriver(inst);
        }
      }, { rootMargin: '256px' });
    }
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const inst = registry.get(entry.target);
          if (inst) measureGlowScale(inst);
        }
      });
    }
  }

  /* pulse-outside glow geometry is authored for a ~350×140 reference card;
     scale the halo per-axis to the element it actually wraps. */
  function measureGlowScale(inst) {
    const rect = inst.el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const clamp = (v) => Math.max(0.35, Math.min(4, v));
    inst.el.style.setProperty('--fxb-sx', String(+clamp(rect.width / 350).toFixed(3)));
    inst.el.style.setProperty('--fxb-sy', String(+clamp(rect.height / 140).toFixed(3)));
  }

  function isPulseType(type) { return type === 'pulse-inner' || type === 'pulse-outside'; }

  function syncPaused(inst) {
    const lit = inst.on || inst.fading;
    const paused = lit && (document.hidden || !inst.visible);
    if (paused) inst.el.setAttribute('data-fxbeam-paused', '');
    else inst.el.removeAttribute('data-fxbeam-paused');
  }

  function syncDriver(inst) {
    const wants = isPulseType(inst.cfg.type) && (inst.on || inst.fading)
      && inst.visible && !document.hidden && !REDUCED && !!inst.driverCfg;
    if (wants && !driven.has(inst)) { driven.add(inst); driverStart(); }
    else if (!wants && driven.has(inst)) { driven.delete(inst); driverStopIfIdle(); }
  }

  /* ── Shared instance stylesheets ────────────────────────────────────────
     The generated CSS is multi-KB and depends on nothing but the build key,
     so every host that resolves to the same key rides ONE <style> tag and
     ONE instance id: a pointer crossing a grid of glass cards costs a single
     sheet parse instead of one per card. Everything an instance keeps for
     itself lives in attributes and inline --fxb-*-<id> properties, so
     sharing the rules never shares state. A key whose last instance leaves
     is kept unreferenced (re-entry then re-parses nothing) until the cache
     outgrows SHEET_CACHE; a referenced sheet is never evicted. */
  const SHEET_CACHE = 16;
  const sheets = new Map(); // buildKey -> { id, styleEl, refs }

  function acquireSheet(buildKey, build) {
    let entry = sheets.get(buildKey);
    if (entry) {
      sheets.delete(buildKey); // re-insert: Map iterates in insertion order, so this is the LRU touch
    } else {
      const id = 'fxb' + (++seq);
      const styleEl = document.createElement('style');
      styleEl.setAttribute('data-fxbeam-style', id);
      styleEl.textContent = build(id);
      document.head.appendChild(styleEl);
      entry = { id, styleEl, refs: 0 };
    }
    sheets.set(buildKey, entry);
    entry.refs++;
    return entry;
  }

  function evictSheets() {
    for (const [k, e] of sheets) {
      if (sheets.size <= SHEET_CACHE) return;
      if (e.refs > 0) continue; // in use — never pulled from under a lit beam
      if (e.styleEl.parentNode) e.styleEl.parentNode.removeChild(e.styleEl);
      sheets.delete(k);
    }
  }

  function releaseSheet(inst) {
    const entry = inst.sheet;
    if (!entry) return;
    inst.sheet = null;
    inst.sheetKey = null;
    if (--entry.refs <= 0) evictSheets();
  }

  /** Every inline custom property keyed to this instance's CURRENT id — the
      state that must not be left behind when the id changes or the instance
      goes away. */
  function clearIdVars(inst) {
    const el = inst.el, id = inst.id;
    if (!id) return;
    el.style.removeProperty(`--fxb-o-${id}`);
    // the REDUCED line-beam park position writes these two per-id props
    el.style.removeProperty(`--fxb-x-${id}`);
    el.style.removeProperty(`--fxb-w-${id}`);
    if (inst.driverCfg) {
      for (const osc of inst.driverCfg.oscillators) el.style.removeProperty(osc.prop);
      if (inst.driverCfg.hue) el.style.removeProperty(inst.driverCfg.hue.prop);
    }
  }

  function rebuild(inst) {
    const { type, duration, hueRange, staticColors } = inst.cfg;
    const theme = resolveTheme();
    /* md/sm output is theme-agnostic (its scalars are tokens that flip on
       their own), so the theme is not part of THEIR key — otherwise a flip
       would fork a byte-identical second sheet for every rotate instance. */
    const themeKey = type === 'md' || type === 'sm' ? '' : theme;
    /* Focus/blur and cart pulses re-attach with identical options: an
       unchanged (type, theme, duration, radius, REDUCED, hueRange,
       staticColors) tuple keeps the sheet and driver config it already has.
       `bloom` is deliberately absent — it is a DOM layer, not a rule. */
    const buildKey = type + '|' + themeKey + '|' + duration + '|' + inst.radius + '|' + REDUCED
      + '|' + (hueRange === undefined ? '' : hueRange) + '|' + !!staticColors;
    if (inst.sheetKey !== buildKey) {
      // acquired before the old one is released, so a same-key re-attach can
      // never drop a sheet's last reference and re-parse it
      const entry = acquireSheet(buildKey, (id) =>
        buildCSS(id, type, theme, duration, inst.radius, REDUCED, { hueRange, staticColors }));
      const moved = entry.id !== inst.id;
      if (moved) clearIdVars(inst); // reads the OLD id and the OLD driver config
      const old = inst.sheet;
      inst.sheet = entry;
      inst.sheetKey = buildKey;
      if (old && --old.refs <= 0) evictSheets();
      if (moved) {
        inst.id = entry.id;
        inst.el.setAttribute('data-fxbeam', entry.id);
      }
      if (isPulseType(type) && !REDUCED) {
        const p = pulseParams(type, theme, duration);
        inst.driverCfg = {
          oscillators: oscillatorDefs(inst.id, p),
          /* staticColors: the driver keeps breathing but writes no hue var —
             the generated CSS carries no hue-rotate() term to read it. */
          hue: staticColors ? null : { prop: `--fxb-hue-${inst.id}`, range: hueRange === undefined ? PULSE_HUE_RANGE : hueRange, period: p.huePeriod },
        };
      } else {
        inst.driverCfg = null;
      }
    }
    /* The bloom is a blurred conic layer that rasters every frame the beam
       animates. Ambience-weight callers drop it outright (`bloom: false`)
       rather than fading it out, so a parked pointer costs a ring and
       nothing else — and so at most ONE bloomed beam is ever animating. */
    if (inst.cfg.bloom === false) {
      if (inst.bloom.parentNode) inst.bloom.parentNode.removeChild(inst.bloom);
    } else if (!inst.bloom.parentNode) {
      inst.el.appendChild(inst.bloom);
    }
    if (ro) {
      if (type === 'pulse-outside') { ro.observe(inst.el); measureGlowScale(inst); }
      else {
        ro.unobserve(inst.el);
        inst.el.style.removeProperty('--fxb-sx');
        inst.el.style.removeProperty('--fxb-sy');
      }
    }
    syncDriver(inst);
  }

  function finishOff(inst) {
    inst.on = false;
    inst.fading = false;
    if (inst.fadeTimer) { clearTimeout(inst.fadeTimer); inst.fadeTimer = null; }
    inst.el.removeAttribute('data-fxbeam-on');
    inst.el.removeAttribute('data-fxbeam-fading');
    inst.el.removeAttribute('data-fxbeam-paused');
    inst.el.style.removeProperty(`--fxb-o-${inst.id}`);
    syncDriver(inst);
  }

  function activate(inst) {
    /* Animation entry point — REDUCED first (§6): no fade, no rotation, no
       pulse; the generated CSS is already static, so lighting the attribute
       shows a still, subtle glow. */
    if (inst.fadeTimer) { clearTimeout(inst.fadeTimer); inst.fadeTimer = null; }
    inst.on = true;
    inst.fading = false;
    inst.el.removeAttribute('data-fxbeam-fading');
    inst.el.setAttribute('data-fxbeam-on', '');
    if (REDUCED) {
      inst.el.style.setProperty(`--fxb-o-${inst.id}`, '1');
      if (inst.cfg.type === 'line') {
        /* Park the traveling glow mid-track instead of at the far-left. */
        inst.el.style.setProperty(`--fxb-x-${inst.id}`, '0.5');
        inst.el.style.setProperty(`--fxb-w-${inst.id}`, '1.5');
      }
    }
    syncPaused(inst);
    syncDriver(inst);
  }

  function deactivate(inst) {
    if (REDUCED || (!inst.on && !inst.fading)) { finishOff(inst); return; }
    inst.on = false;
    inst.fading = true;
    inst.el.removeAttribute('data-fxbeam-on');
    inst.el.setAttribute('data-fxbeam-fading', '');
    syncPaused(inst);
    syncDriver(inst);
    /* Safety net: display:none (or a paused subtree) never fires
       animationend; settle the fade-out after its 0.5s + margin. */
    inst.fadeTimer = setTimeout(() => { if (inst.fading) finishOff(inst); }, 800);
  }

  function createInstance(el) {
    ensureWiring();
    const bloom = document.createElement('div');
    bloom.setAttribute('data-fxbeam-bloom', '');
    bloom.setAttribute('aria-hidden', 'true');
    el.appendChild(bloom);
    const inst = {
      /* id and sheet are claimed by the first rebuild — which sheet an
         instance shares depends on options it does not have yet. */
      id: null, el, sheet: null, bloom,
      cfg: null, radius: 13, driverCfg: null, sheetKey: null,
      on: false, fading: false, visible: true, fadeTimer: null,
      onAnimEnd: null,
    };
    inst.onAnimEnd = (e) => {
      if (e.target !== el) return;
      if (e.animationName === `fxb-fade-out-${inst.id}` && inst.fading) finishOff(inst);
    };
    el.addEventListener('animationend', inst.onAnimEnd);
    if (io) io.observe(el);
    return inst;
  }

  /* The per-type token stems the brightness/saturation knobs override. */
  const KNOB_TOK = { md: 'md', sm: 'sm', line: 'line', 'pulse-inner': 'pi', 'pulse-outside': 'po' };

  /** Reflect the scalar knobs as inline vars. Clearing every stem first is
      what makes a knob-less re-attach (or a type change) fall back to the
      theme tokens instead of inheriting a stale override. */
  function applyKnobVars(inst) {
    const el = inst.el;
    for (const t of Object.values(KNOB_TOK)) {
      el.style.removeProperty(`--fxb-${t}-bright`);
      el.style.removeProperty(`--fxb-${t}-sat`);
    }
    const tok = KNOB_TOK[inst.cfg.type];
    if (inst.cfg.brightness !== undefined) el.style.setProperty(`--fxb-${tok}-bright`, String(inst.cfg.brightness));
    if (inst.cfg.saturation !== undefined) el.style.setProperty(`--fxb-${tok}-sat`, String(inst.cfg.saturation));
    /* opacity is a second [0,1] master fader (the upstream prop); it folds
       into the strength var so every layer's opacity calc already carries it. */
    const opacity = inst.cfg.opacity === undefined ? 1 : inst.cfg.opacity;
    el.style.setProperty('--fxb-strength', String(inst.cfg.strength * opacity));
  }

  /** Callbacks are caller code: a throw must never break the lifecycle. */
  function fireCb(fn, el) {
    if (!fn) return;
    try { fn(el); } catch (err) { console.error('[FxBeam] state callback failed:', err); }
  }

  function attach(el, opts) {
    if (!el || el.nodeType !== 1) throw new TypeError('FxBeam.attach: expected an element');
    const cfg = normalizeOpts(opts);
    let inst = registry.get(el);
    if (!inst) {
      inst = createInstance(el);
      registry.set(el, inst);
    }
    const wasLit = inst.on || inst.fading;
    /* detectRadius forces a style flush; the host's corner radius only
       matters again when the beam TYPE changes (each type derives its own
       radii from it), so a same-type re-attach skips the read. A caller-
       supplied borderRadius skips the read entirely — and dropping the
       override on a later attach goes back to measuring. */
    if (cfg.borderRadius !== undefined) inst.radius = cfg.borderRadius;
    else if (!inst.cfg || inst.cfg.type !== cfg.type || inst.cfg.borderRadius !== undefined) inst.radius = detectRadius(el, cfg.type);
    inst.cfg = cfg;
    applyKnobVars(inst);
    rebuild(inst);
    if (cfg.active && !wasLit) { activate(inst); fireCb(cfg.onActivate, el); }
    else if (!cfg.active && wasLit) { deactivate(inst); fireCb(cfg.onDeactivate, el); }
    else if (cfg.active && inst.fading) activate(inst); /* re-lit mid-fade — never fully off, so no edge fires */
    return el;
  }

  function detach(el) {
    const inst = registry.get(el);
    if (!inst) return;
    const wasLit = inst.on || inst.fading;
    finishOff(inst);
    if (io) io.unobserve(el);
    if (ro) ro.unobserve(el);
    el.removeEventListener('animationend', inst.onAnimEnd);
    if (inst.bloom.parentNode) inst.bloom.parentNode.removeChild(inst.bloom);
    clearIdVars(inst);
    releaseSheet(inst);
    el.removeAttribute('data-fxbeam');
    el.style.removeProperty('--fxb-strength');
    el.style.removeProperty('--fxb-sx');
    el.style.removeProperty('--fxb-sy');
    // the per-attach brightness/saturation overrides go with the instance
    for (const t of Object.values(KNOB_TOK)) {
      el.style.removeProperty(`--fxb-${t}-bright`);
      el.style.removeProperty(`--fxb-${t}-sat`);
    }
    registry.delete(el);
    /* Detaching a lit beam IS its deactivation edge. After the registry
       delete, so a callback that re-attaches sees a clean slate. */
    if (wasLit && inst.cfg) fireCb(inst.cfg.onDeactivate, el);
  }

  return {
    attach,
    detach,
    /* Pure logic, exposed for the node:test extraction suite. */
    _internals: {
      TYPES, PALETTE, HUE_RANGE, LINE_HUE_RANGE, PULSE_HUE_RANGE,
      PULSE_RING_MAP, PULSE_INNER_SIZES, PULSE_INNER_BLOOM, PULSE_OUTER_CORE, PULSE_OUTER_BLOOM,
      pingPong, oscValue, hueValue, pulseParams, oscillatorDefs, normalizeOpts, buildCSS,
    },
  };
})();
/* ═══ end FX: Border Beam ═══ */

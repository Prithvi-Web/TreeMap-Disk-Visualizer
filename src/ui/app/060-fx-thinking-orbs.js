/* ═══════════════ FX: Thinking Orbs ═══════════════ */
/* Dotted 3D thought-orb activity indicators, ported verbatim from
   thinking-orbs v0.3.1 (MIT © Jakub Antalik) — nine hand-tuned states
   (working / searching / solving / listening / connecting / weaving /
   composing / breathing / shaping), each shipped at two purpose-tuned
   sizes (64 chat-avatar, 20 inline-text; separate designs, not a scale
   factor). Strictly monochrome ink: light dots on dark, dark dots on
   light, resolved live from an ancestor data-theme attr / dark|light
   class, else prefers-color-scheme. Plain 2D canvas arc fills only —
   no filters, no WebGL.

   Usage:
     const orb = FxOrbs.mount(container, { state: 'searching', size: 20 });
     orb.setState('solving'); orb.pause(); orb.resume(); orb.destroy();

   One shared clock + ONE shared rAF loop drives every mounted orb, and
   the loop fully stops when no orb is animating or the tab is hidden.
   REDUCED (the app-wide prefers-reduced-motion const) renders a single
   static frame and never animates. The geometry core is deliberately
   closure-free and Math-only, so tests/fxOrbs tests evaluate it in Node
   and compare against thinking-orbs' published golden frame vectors. */
const FxOrbs = (() => {

  /* ── core: shared primitives (thinking-orbs src/engine/core.ts) ──
     Honestly 3D — rotated, depth-shaded, z-sorted. Depth is carried by
     dot size and ink weight alone. `white` is the paper-theme ink value
     in [0,1]; on a dark substrate the painter mirrors it (1 - white) so
     near dots read bright — the same depth language, inverted paper. */

  function lerp(a, b, f) {
    return a + (b - a) * f;
  }

  function frac(x) {
    return x - Math.floor(x);
  }

  /** Deterministic hash in [0, 1). */
  function hashD(a, b) {
    const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return h - Math.floor(h);
  }

  /** Value noise on a 2D lattice — smooth, deterministic, cheap. */
  function vnoise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let fx = x - xi;
    let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = hashD(xi, yi);
    const b = hashD(xi + 1, yi);
    const c = hashD(xi, yi + 1);
    const d = hashD(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  /** Stable directions on a unit sphere (Fibonacci lattice). */
  function fibDir(i, n) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - (2 * (i + 0.5)) / n;
    const rad = Math.sqrt(1 - y * y);
    const a = i * golden;
    return [rad * Math.cos(a), y, rad * Math.sin(a)];
  }

  /** Shortest signed angular distance, wrapped to (-π, π]. */
  function angleDelta(a, b) {
    return Math.atan2(Math.sin(a - b), Math.cos(a - b));
  }

  /** Shared spin + tilt + orthographic projection. */
  function makeProj(yaw, tilt, cx, cy, scale) {
    const st = Math.sin(tilt);
    const ct = Math.cos(tilt);
    const sy = Math.sin(yaw);
    const cyw = Math.cos(yaw);
    return (x, y, z) => {
      const x1 = x * cyw + z * sy;
      const z1 = -x * sy + z * cyw;
      const y1 = y * ct - z1 * st;
      const z2 = y * st + z1 * ct;
      return [cx + x1 * scale, cy - y1 * scale, z2];
    };
  }

  /**
   * Turn raw mode output into a finished frame: drop invisible marks,
   * clamp radii to the mode's floor, z-sort far→near into draw order.
   * A frame is a complete set of draw instructions — every value final,
   * array order = draw order — which is what lets the golden-vector
   * tests compare numbers instead of pixels.
   */
  function finalizeFrame(dots, lines, rMin = 0.3) {
    const visible = [];
    for (const d of dots) {
      if ((d.a ?? 1) < 0.02) continue;
      d.r = Math.max(rMin, d.r);
      visible.push(d);
    }
    visible.sort((a, b) => a.z - b.z);
    return { dots: visible, lines: lines.filter((l) => (l.a ?? 1) >= 0.02) };
  }

  /** Painter: matte grayscale dots; dark substrates mirror the ink. */
  function fxPaintDots(ctx, dots, dark) {
    for (const d of dots) {
      const alpha = d.a ?? 1;
      const w = Math.min(1, Math.max(0, d.white));
      const g = Math.round((dark ? 1 - w : w) * 255);
      ctx.fillStyle = `rgba(${g},${g},${g},${alpha})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Stroke pass for edge-based modes. Runs first so nodes sit on top. */
  function fxPaintLines(ctx, lines, dark) {
    for (const l of lines) {
      const alpha = l.a ?? 1;
      const w = Math.min(1, Math.max(0, l.white));
      const g = Math.round((dark ? 1 - w : w) * 255);
      ctx.strokeStyle = `rgba(${g},${g},${g},${alpha})`;
      ctx.lineWidth = l.w;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
  }

  /** Paint a finished frame. Lines first, so nodes sit on their edges. */
  function paintFrame(ctx, frame, dark) {
    if (frame.lines.length) fxPaintLines(ctx, frame.lines, dark);
    fxPaintDots(ctx, frame.dots, dark);
  }

  /**
   * Dot radii were tuned for a 300pt frame; sub-linear scaling keeps
   * small spinners legible. Lower pow = radii shrink less with size.
   */
  function radiusScale(size, pow) {
    return (size / 300) ** pow;
  }

  /* ── profiles: density rows + multiplier machinery (profiles.ts) ── */

  // 2-D lattices (rings × dots-per-ring) come in pairs — each side takes
  // √scale so the TOTAL dot count scales by `scale`; flat lists scale
  // linearly. `iconD` sets the morph outline's sampling density.
  const COUNT_PAIRS = [
    ['latRings', 'lonDensity'],
    ['rings', 'lonDensity'],
    ['lanes', 'segs']
  ];
  const COUNT_KEYS = ['orbitN', 'ghostN', 'nodeN', 'strandN', 'signals'];
  const ICON_DENSITY_KEYS = ['iconD'];

  // Every key that sets a dot's rendered radius — scaling all of them
  // keeps a dot's near/far falloff intact while resizing the mark.
  const RADIUS_KEYS = [
    'rBase',
    'rDepth',
    'rActive',
    'rDot',
    'ghostR',
    'partR',
    'partRDepth',
    'nodeR',
    'nodeRDepth'
  ];

  function scaleCounts(opts, scale) {
    const out = { ...opts };
    const done = new Set();
    const rt = Math.sqrt(scale);
    for (const [a, b] of COUNT_PAIRS) {
      const va = out[a];
      const vb = out[b];
      if (va != null && vb != null && !done.has(a) && !done.has(b)) {
        out[a] = Math.max(2, Math.round(va * rt));
        out[b] = Math.max(2, Math.round(vb * rt));
        done.add(a);
        done.add(b);
      }
    }
    for (const k of COUNT_KEYS) {
      const v = out[k];
      // 0 means the mode opted out of that layer entirely (ring has no
      // ghost sphere) — scaling must not resurrect it as one stray dot
      if (v != null && v !== 0 && !done.has(k)) out[k] = Math.max(1, Math.round(v * scale));
    }
    for (const k of ICON_DENSITY_KEYS) {
      const v = out[k];
      if (v != null) out[k] = Math.max(0.02, v * scale);
    }
    return out;
  }

  function scaleRadii(opts, scale) {
    const out = { ...opts };
    for (const k of RADIUS_KEYS) {
      const v = out[k];
      if (v != null) out[k] = v * scale;
    }
    // remember the multiplier itself — spacing-derived radii (the morph
    // outline) use it, since they aren't based on any single radius key
    out.rSizeMul = (out.rSizeMul ?? 1) * scale;
    return out;
  }

  /** Base (fine) profiles per mode, before preset multipliers. */
  const BASE_PROFILES = {
    globe: {
      latRings: 17,
      lonDensity: 44,
      rBase: 0.6,
      rDepth: 1.7,
      rBoost: 1.0,
      inkFar: 0.62,
      inkSpan: 0.54,
      rsPow: 0.6,
      rMin: 0.3
    },
    orbits: {
      orbitN: 12,
      ghostN: 40,
      ghostR: 0.9,
      ghostA: 0.5,
      particles: 3,
      partR: 1.2,
      partRDepth: 1.6,
      rsPow: 0.6,
      rMin: 0.3
    },
    rubik: {
      latRings: 15,
      lonDensity: 40,
      moveCount: 14,
      rBase: 0.6,
      rDepth: 1.7,
      rActive: 0.3,
      inkFar: 0.62,
      inkSpan: 0.54,
      rsPow: 0.6,
      rMin: 0.3
    },
    wave: {
      rings: 15,
      lonDensity: 40,
      rBase: 0.6,
      rDepth: 1.7,
      rsPow: 0.6,
      rMin: 0.3
    },
    web: {
      nodeN: 30,
      thr: 0.72,
      signals: 5,
      nodeR: 1.4,
      nodeRDepth: 1.8,
      lineW: 0.8,
      rsPow: 0.6,
      rMin: 0.3
    },
    braid: {
      strandN: 52,
      turns: 3.0,
      ghostN: 150,
      rBase: 1.2,
      rDepth: 1.8,
      rsPow: 0.6,
      rMin: 0.3
    },
    ribbon: {
      lanes: 5,
      segs: 88,
      ghostN: 150,
      rBase: 1.1,
      rDepth: 1.7,
      rsPow: 0.6,
      rMin: 0.3
    },
    // ring shares ribbon's painter; faceOn cancels the camera tilt and
    // moves the undulation onto the radius; no ghost sphere behind it
    ring: {
      lanes: 5,
      segs: 88,
      ghostN: 0,
      faceOn: 1,
      rBase: 1.1,
      rDepth: 1.7,
      rsPow: 0.6,
      rMin: 0.3
    },
    morph: {
      rDot: 0.021,
      iconD: 1,
      rMin: 0.25
    }
  };

  /* ── orbits: particles on tilted orbits — "working" (orbits.ts) ── */

  const frameOrbits = (size, t, o) => {
    const cx = size / 2;
    const cy = size / 2;
    const R = (size / 2) * 0.82;
    const pt = makeProj(t * 0.12, 0.3, cx, cy, 1);
    const rs = radiusScale(size, o.rsPow ?? 0.6);

    const dots = [];
    const orbitN = o.orbitN ?? 12;
    const ghostN = o.ghostN ?? 40;
    const particles = o.particles ?? 3;

    // orbits: each a tilted circle — a ghost path + running particles
    for (let orb = 0; orb < orbitN; orb++) {
      const h1 = hashD(orb, 1.7);
      const h2 = hashD(orb, 5.2);
      const h3 = hashD(orb, 8.9);
      const ro = R * (0.45 + 0.52 * h1);
      const th = h1 * 2 * Math.PI;
      const phi = Math.acos(2 * h2 - 1);
      // orbit plane basis (u, v ⟂ normal n)
      const nx = Math.sin(phi) * Math.cos(th);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(th);
      let ux = -ny;
      let uy = nx;
      const uz = 0;
      const ul = Math.max(1e-6, Math.sqrt(ux * ux + uy * uy));
      ux /= ul;
      uy /= ul;
      const vx = ny * uz - nz * uy;
      const vy = nz * ux - nx * uz;
      const vz = nx * uy - ny * ux;
      const speed = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1);

      // ghost path
      for (let k = 0; k < ghostN; k++) {
        const a = (k / ghostN) * 2 * Math.PI;
        const [px, py, z] = pt(
          (ux * Math.cos(a) + vx * Math.sin(a)) * ro,
          (uy * Math.cos(a) + vy * Math.sin(a)) * ro,
          (uz * Math.cos(a) + vz * Math.sin(a)) * ro
        );
        const depth = (z / ro + 1) / 2;
        dots.push({
          x: px,
          y: py,
          z,
          r: (o.ghostR ?? 0.9) * rs,
          white: 0.72,
          a: (o.ghostA ?? 0.5) * (0.4 + 0.6 * depth)
        });
      }
      // the particles doing the work
      for (let m = 0; m < particles; m++) {
        const a = t * speed + (m / particles) * 2 * Math.PI + h2 * 6;
        const [px, py, z] = pt(
          (ux * Math.cos(a) + vx * Math.sin(a)) * ro,
          (uy * Math.cos(a) + vy * Math.sin(a)) * ro,
          (uz * Math.cos(a) + vz * Math.sin(a)) * ro
        );
        const depth = (z / ro + 1) / 2;
        dots.push({
          x: px,
          y: py,
          z,
          r: ((o.partR ?? 1.2) + (o.partRDepth ?? 1.6) * depth) * rs,
          white: 0.3 - 0.22 * depth
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  /* ── lattice trio: globe / rubik / wave (lattice.ts) ── */

  // The solver heartbeat (rubik): rapid eased moves scramble, then
  // replay in reverse (palindrome) so everything clicks back to solved.
  function solveCycle(time, count, slotDur, rest) {
    const cyc = 2 * count * slotDur + rest;
    const tc = time % cyc;
    const amount = new Array(count).fill(0);
    let active = -1;
    if (tc < 2 * count * slotDur) {
      const slot = Math.floor(tc / slotDur);
      const p = (tc - slot * slotDur) / slotDur;
      const cl = Math.min(1, p / 0.7);
      const ep = 1 - (1 - cl) ** 3; // machine ease-out
      if (slot < count) {
        for (let i = 0; i < slot; i++) amount[i] = 1;
        amount[slot] = ep;
        active = slot;
      } else {
        const u = 2 * count - 1 - slot;
        for (let i = 0; i < u; i++) amount[i] = 1;
        amount[u] = 1 - ep;
        active = u;
      }
    }
    return { amount, active };
  }

  function applyMoves(pt3, moves, sc) {
    let [x, y, z] = pt3;
    let inActive = false;
    for (let i = 0; i < moves.length; i++) {
      if (sc.amount[i] <= 0) continue;
      const mv = moves[i];
      const coord = mv.axis === 0 ? x : mv.axis === 1 ? y : z;
      if (coord < mv.lo || coord >= mv.hi) continue;
      if (i === sc.active) inActive = true;
      const a = mv.ang * sc.amount[i];
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      if (mv.axis === 0) {
        const y2 = y * ca - z * sa;
        z = y * sa + z * ca;
        y = y2;
      } else if (mv.axis === 1) {
        const x2 = x * ca + z * sa;
        z = -x * sa + z * ca;
        x = x2;
      } else {
        const x2 = x * ca - y * sa;
        y = x * sa + y * ca;
        x = x2;
      }
    }
    return [x, y, z, inActive];
  }

  function makeMoves(count) {
    const moves = [];
    for (let i = 0; i < count; i++) {
      const axis = Math.min(2, Math.floor(hashD(i, 2.3) * 3));
      const lo = -1.0 + 0.5 * Math.min(3, Math.floor(hashD(i, 5.9) * 4));
      const dir = hashD(i, 7.7) < 0.5 ? 1 : -1;
      moves.push({ axis, lo, hi: lo + 0.5, ang: (dir * Math.PI) / 2 });
    }
    return moves;
  }

  // Globe: lat/long field, a scan meridian sweeps — "searching"
  const frameGlobe = (size, t, o) => {
    const spin = 0.5;
    const cx = size / 2;
    const cy = size / 2;
    const radius = (size / 2) * 0.82;
    const tilt = 0.4 + 0.06 * Math.sin(t * 0.35);
    const pt = makeProj(t * spin, tilt, cx, cy, radius);
    // scan sweeps relative to the spin; scanMul scales that relative rate
    const scan = t * (spin + (1.7 - spin) * (o.scanMul ?? 1));
    const rs = radiusScale(size, o.rsPow ?? 0.6);
    const dimBase = o.dimBase ?? 1;

    const dots = [];
    const latRings = o.latRings ?? 17;
    const lonDensity = o.lonDensity ?? 44;
    for (let li = 0; li <= latRings; li++) {
      const lat = -Math.PI / 2 + (li / latRings) * Math.PI;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
      for (let lj = 0; lj < lonCount; lj++) {
        const lon = (lj / lonCount) * 2 * Math.PI;
        const [px, py, z] = pt(cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon));
        const depth = (z + 1) / 2;
        // the scan: a moving meridian read as a size ripple, not a shine
        const d = angleDelta(lon + t * spin, scan);
        const boost = Math.exp(-(d * d) / 0.18) * Math.max(0, z);
        dots.push({
          x: px,
          y: py,
          z,
          r: ((o.rBase ?? 0.6) + (o.rDepth ?? 1.7) * depth + (o.rBoost ?? 1) * boost) * rs,
          white: (o.inkFar ?? 0.62) - (o.inkSpan ?? 0.54) * depth,
          // dimBase < 1 fades un-scanned dots so the meridian reads clearly
          a: dimBase + (1 - dimBase) * Math.min(1, boost)
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  // Rubik: bands twist in quarter turns, scramble → solve — "solving"
  const frameRubik = (size, t, o) => {
    const cx = size / 2;
    const cy = size / 2;
    const R = (size / 2) * 0.82;
    const pt = makeProj(t * 0.55, 0.35 + 0.1 * Math.sin(t * 0.9), cx, cy, R);
    const rs = radiusScale(size, o.rsPow ?? 0.6);
    const moveCount = o.moveCount ?? 14;
    const moves = makeMoves(moveCount);
    const sc = solveCycle(t, moveCount, 0.42, 1.2);

    const dots = [];
    const latRings = o.latRings ?? 15;
    const lonDensity = o.lonDensity ?? 40;
    for (let li = 0; li <= latRings; li++) {
      const lat = -Math.PI / 2 + (li / latRings) * Math.PI;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
      for (let lj = 0; lj < lonCount; lj++) {
        const lon = (lj / lonCount) * 2 * Math.PI;
        const [x, y, z, inActive] = applyMoves(
          [cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon)],
          moves,
          sc
        );
        const [px, py, zr] = pt(x, y, z);
        const depth = (zr + 1) / 2;
        // the band being turned inks a touch darker — the "hand"
        dots.push({
          x: px,
          y: py,
          z: zr,
          r: ((o.rBase ?? 0.6) + (o.rDepth ?? 1.7) * depth + (inActive ? (o.rActive ?? 0.3) : 0)) * rs,
          white: (o.inkFar ?? 0.62) - (o.inkSpan ?? 0.54) * depth - (inActive ? 0.14 : 0)
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  // Wave: a waveform rolls through the rings — "listening"
  const frameWave = (size, t, o) => {
    const cx = size / 2;
    const cy = size / 2;
    // 0.76 base × 1.15 — the undulation pulls the sphere inward, so wave
    // read ~15% smaller than the other lattice modes; scaled to match
    const R = (size / 2) * 0.874;
    const pt = makeProj(t * 0.18, 0.38, cx, cy, 1);
    const rs = radiusScale(size, o.rsPow ?? 0.6);

    const dots = [];
    const rings = o.rings ?? 15;
    const lonDensity = o.lonDensity ?? 40;
    for (let ri = 0; ri <= rings; ri++) {
      const lat = -Math.PI / 2 + (ri / rings) * Math.PI;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      // two waves, different tempi — organic, never quite repeating
      const w = 0.62 * Math.sin(t * 2.1 - ri * 0.52) + 0.38 * Math.sin(t * 1.27 + ri * 0.83);
      const rr = R * (0.88 + 0.105 * w);
      const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
      for (let lj = 0; lj < lonCount; lj++) {
        const lon = (lj / lonCount) * 2 * Math.PI;
        const [px, py, z] = pt(cosLat * Math.cos(lon) * rr, sinLat * rr, cosLat * Math.sin(lon) * rr);
        const depth = (z / R + 1) / 2;
        const crest = Math.max(0, w);
        dots.push({
          x: px,
          y: py,
          z,
          r: ((o.rBase ?? 0.6) + (o.rDepth ?? 1.7) * depth) * (1 + 0.4 * crest) * rs,
          white: 0.66 - 0.56 * depth - 0.1 * crest
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  /* ── web: a constellation wires itself — "connecting" (web.ts) ── */

  const frameWeb = (size, t, o) => {
    const cx = size / 2;
    const cy = size / 2;
    const R = (size / 2) * 0.8 * (o.spread ?? 1);
    // the projector carries the radius as its scale, so node vectors stay
    // unit-length and distances below are in unit-sphere space
    const pt = makeProj(t * 0.12, 0.32, cx, cy, R);
    const rs = radiusScale(size, o.rsPow ?? 0.6);

    const nodeN = o.nodeN ?? 30;
    const thr = o.thr ?? 0.72;
    const nodeR = o.nodeR ?? 1.4;
    const nodeRDepth = o.nodeRDepth ?? 1.8;

    // nodes: fib lattice + slow noise wander, renormalised to the surface
    const nodes = [];
    for (let i = 0; i < nodeN; i++) {
      const d = fibDir(i, nodeN);
      const x = d[0] + 0.3 * (vnoise(i * 0.31 + 9, t * 0.24) - 0.5) * 2;
      const y = d[1] + 0.3 * (vnoise(i * 0.53 + 27, t * 0.21) - 0.5) * 2;
      const z = d[2] + 0.3 * (vnoise(i * 0.77 + 55, t * 0.27) - 0.5) * 2;
      const l = Math.sqrt(x * x + y * y + z * z);
      nodes.push([x / l, y / l, z / l]);
    }

    const lines = [];
    const dots = [];

    // edges between close neighbours, alpha by proximity + depth
    for (let i = 0; i < nodeN; i++) {
      for (let j = i + 1; j < nodeN; j++) {
        const dx = nodes[i][0] - nodes[j][0];
        const dy = nodes[i][1] - nodes[j][1];
        const dz = nodes[i][2] - nodes[j][2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist >= thr) continue;
        const [x1, y1, z1] = pt(nodes[i][0], nodes[i][1], nodes[i][2]);
        const [x2, y2, z2] = pt(nodes[j][0], nodes[j][1], nodes[j][2]);
        const depth = ((z1 + z2) / 2 + 1) / 2;
        lines.push({
          x1,
          y1,
          x2,
          y2,
          white: 0.42,
          a: (1 - dist / thr) * (0.3 + 0.55 * depth),
          w: Math.max(0.6, (o.lineW ?? 0.8) * rs)
        });
      }
    }

    for (let i = 0; i < nodeN; i++) {
      const [px, py, z] = pt(nodes[i][0], nodes[i][1], nodes[i][2]);
      const depth = (z + 1) / 2;
      const pulse = 1 + 0.25 * Math.sin(t * 1.4 + i * 2.7);
      dots.push({
        x: px,
        y: py,
        z,
        r: (nodeR + nodeRDepth * depth) * pulse * rs,
        white: 0.55 - 0.45 * depth
      });
    }

    // signals: bright packets running between paired nodes
    const signals = o.signals ?? 5;
    for (let s = 0; s < signals; s++) {
      const seg = Math.floor(t * 0.55 + s * 7.31);
      const a = Math.floor(hashD(seg, s * 3.1 + 1.7) * nodeN);
      const b = Math.floor(hashD(seg, s * 5.7 + 4.2) * nodeN);
      if (a === b) continue;
      const f = frac(t * 0.55 + s * 7.31);
      const x = lerp(nodes[a][0], nodes[b][0], f);
      const y = lerp(nodes[a][1], nodes[b][1], f);
      const z = lerp(nodes[a][2], nodes[b][2], f);
      const l = Math.max(1e-6, Math.sqrt(x * x + y * y + z * z));
      const [px, py, zr] = pt(x / l, y / l, z / l);
      const depth = (zr + 1) / 2;
      dots.push({
        x: px,
        y: py,
        z: zr,
        r: (nodeR * 1.5 + nodeRDepth * depth) * rs,
        white: 0.05,
        a: 0.5 + 0.5 * depth
      });
    }

    return finalizeFrame(dots, lines, o.rMin);
  };

  /* ── braid: three strands plait the sphere — "weaving" (braid.ts) ── */

  const frameBraid = (size, t, o) => {
    const cx = size / 2;
    const cy = size / 2;
    const R = (size / 2) * 0.76;
    const pt = makeProj(t * 0.4, 0.3, cx, cy, 1);
    const rs = radiusScale(size, o.rsPow ?? 0.6);

    const dots = [];
    const ghostN = o.ghostN ?? 150;
    for (let i = 0; i < ghostN; i++) {
      const d = fibDir(i, ghostN);
      const [px, py, z] = pt(d[0] * R, d[1] * R, d[2] * R);
      const depth = (z / R + 1) / 2;
      dots.push({ x: px, y: py, z, r: 0.8 * rs, white: 0.78, a: 0.1 + 0.22 * depth });
    }

    const strandN = o.strandN ?? 52;
    const turns = o.turns ?? 3;
    for (let s = 0; s < 3; s++) {
      const phase = (s / 3) * 2 * Math.PI;
      for (let i = 0; i < strandN; i++) {
        // u walks pole to pole; frac() drift slides the strand along
        const u = (frac(i / strandN + t * 0.045) * 2 - 1) * 0.96;
        const surf = Math.sqrt(Math.max(0, 1 - u * u));
        const endFade = Math.min(1, (1 - Math.abs(u)) / 0.1);
        const a = u * Math.PI * turns + phase;
        // radial breathing: strands trade places — the plait's over/under
        const weave = 1 + 0.075 * Math.sin(u * Math.PI * turns * 2 + phase * 2 + t * 0.8);
        const rr = surf * R * weave;
        const [px, py, zr] = pt(Math.cos(a) * rr, u * R * weave, Math.sin(a) * rr);
        const depth = (zr / R + 1) / 2;
        dots.push({
          x: px,
          y: py,
          z: zr,
          r: ((o.rBase ?? 1.2) + (o.rDepth ?? 1.8) * depth) * rs,
          white: 0.55 - 0.45 * depth,
          a: endFade * (0.45 + 0.55 * depth)
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  /* ── ribbon / ring: sash & breathing circle (ribbon.ts) ──
     The same painter drives "composing" (ribbon) and "breathing" (ring),
     via the faceOn flag: face-on cancels the camera tilt and moves the
     undulation onto the in-plane radius. */

  const frameRibbon = (size, t, o) => {
    const cx = size / 2;
    const cy = size / 2;
    const R = (size / 2) * 0.78;
    // spin scales the 3D tumble; spin=0 freezes the band's orientation,
    // leaving only the traveling undulation
    const spin = o.spin ?? 1;
    const camTilt = 0.3;
    const pt = makeProj(t * 0.1 * spin, camTilt, cx, cy, 1);
    const rs = radiusScale(size, o.rsPow ?? 0.6);

    const dots = [];
    const ghostN = o.ghostN ?? 150;
    for (let i = 0; i < ghostN; i++) {
      const d = fibDir(i, ghostN);
      const [px, py, z] = pt(d[0] * R, d[1] * R, d[2] * R);
      const depth = (z / R + 1) / 2;
      dots.push({ x: px, y: py, z, r: 0.8 * rs, white: 0.78, a: 0.1 + 0.22 * depth });
    }

    // The band plane, precessing (frozen when spin=0). Face-on sets
    // ta = -camTilt so the band reads as a true circle, not an ellipse.
    const ya = t * 0.24 * spin;
    const ta = o.faceOn ? -camTilt : 0.55 + 0.3 * Math.sin(t * 0.18) * spin;
    const ux = Math.cos(ya);
    const uy = 0;
    const uz = Math.sin(ya);
    const vx = -uz * Math.sin(ta);
    const vy = Math.cos(ta);
    const vz = ux * Math.sin(ta);
    // plane normal n = u × v
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;

    // Radial lobes swell past R, so pull the base radius in by (most of)
    // the wobble amplitude — the silhouette stays inside the frame.
    const wobAmp = 0.23 * (o.wobMul ?? 1);
    const baseR = o.faceOn ? R / (1 + 0.85 * wobAmp) : R;

    const baseLanes = o.lanes ?? 5;
    const segs = o.segs ?? 88;
    const lanes = Math.max(1, Math.round(baseLanes * (o.bandMul ?? 1)));
    for (let w = 0; w < lanes; w++) {
      const laneOff = (w - (lanes - 1) / 2) * 0.075;
      const edge = Math.abs(w - (lanes - 1) / 2) / Math.max(1, (lanes - 1) / 2);
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * 2 * Math.PI;
        // the undulation: two traveling waves along the band; wobMul
        // scales the deformation — 0 is a clean band
        const wob =
          (0.16 * Math.sin(a * 3 - t * 1.7 + w * 0.22) + 0.07 * Math.sin(a * 5 + t * 1.1)) *
          (o.wobMul ?? 1);
        // Face-on modulates the in-plane RADIUS so lobes genuinely swell
        // and pinch; ribbon keeps the out-of-plane sash wobble.
        const radial = o.faceOn ? 1 + wob : 1;
        const off = o.faceOn ? laneOff : laneOff + wob;
        const x = ux * Math.cos(a) + vx * Math.sin(a) + nx * off;
        const y = uy * Math.cos(a) + vy * Math.sin(a) + ny * off;
        const z = uz * Math.cos(a) + vz * Math.sin(a) + nz * off;
        const l = Math.sqrt(x * x + y * y + z * z);
        const rr = baseR * radial;
        const [px, py, zr] = pt((x / l) * rr, (y / l) * rr, (z / l) * rr);
        const depth = (zr / R + 1) / 2;
        dots.push({
          x: px,
          y: py,
          z: zr,
          r: ((o.rBase ?? 1.1) + (o.rDepth ?? 1.7) * depth) * (1 - 0.25 * edge) * rs,
          white: 0.52 - 0.44 * depth + 0.18 * edge,
          a: 0.4 + 0.6 * depth
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  /* ── morph: circle → triangle → square outline — "shaping" (morph.ts) ──
     Each shape is a closed path parameterised by arc length (top-centre
     start, clockwise); every frame blends the two neighbouring paths,
     then lays the dots EVENLY along the blended outline. */

  function smoothE(x) {
    return x * x * (3 - 2 * x);
  }

  function polyPath(verts) {
    const V = verts.length;
    const L = [];
    let total = 0;
    for (let i = 0; i < V; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % V];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      L.push(l);
      total += l;
    }
    return (f) => {
      let target = f * total;
      let i = 0;
      while (target > L[i] && i < V - 1) {
        target -= L[i];
        i++;
      }
      const a = verts[i];
      const b = verts[(i + 1) % V];
      const ff = L[i] ? Math.min(1, target / L[i]) : 0;
      return [a[0] + (b[0] - a[0]) * ff, a[1] + (b[1] - a[1]) * ff];
    };
  }

  const MORPH_CIRCLE = (f) => {
    const a = -Math.PI / 2 + f * 2 * Math.PI;
    return [Math.cos(a) * 0.24, Math.sin(a) * 0.24];
  };
  const MORPH_TRIANGLE = polyPath([
    [0.0, -0.26],
    [0.24, 0.16],
    [-0.24, 0.16]
  ]);
  // 5-vertex walk so the path STARTS at top-centre like the other shapes
  const MORPH_SQUARE = polyPath([
    [0, -0.2],
    [0.2, -0.2],
    [0.2, 0.2],
    [-0.2, 0.2],
    [-0.2, -0.2]
  ]);
  const MORPH_CYCLE = [MORPH_CIRCLE, MORPH_TRIANGLE, MORPH_SQUARE];

  // low floor keeps sparse outlines possible while never degenerating
  function morphN(d) {
    return Math.max(6, Math.round(34 * d));
  }

  const MORPH_HOLD = 1.4;
  const MORPH_MORPH = 0.9;
  const MORPH_SEG = MORPH_HOLD + MORPH_MORPH;

  const frameMorph = (size, t, o) => {
    const K = MORPH_CYCLE.length;
    const tc = t % (MORPH_SEG * K);
    const k = Math.floor(tc / MORPH_SEG);
    const local = tc - k * MORPH_SEG;
    const m = local > MORPH_HOLD ? smoothE((local - MORPH_HOLD) / MORPH_MORPH) : 0;
    const sprd = o.spread ?? 1;

    // blend the two shape PATHS at m, then measure the blended outline
    const pA = MORPH_CYCLE[k];
    const pB = MORPH_CYCLE[(k + 1) % K];
    const M = 160;
    const pts = [];
    for (let i = 0; i < M; i++) {
      const f = i / M;
      const a = pA(f);
      const b = pB(f);
      pts.push([(a[0] + (b[0] - a[0]) * m) * sprd, (a[1] + (b[1] - a[1]) * m) * sprd]);
    }
    const L = [];
    let total = 0;
    for (let i = 0; i < M; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % M];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      L.push(l);
      total += l;
    }

    // dot radius depends ONLY on rDot (the size knob); the count sets the
    // gaps. Formed shapes breathe a little (uniform pulse).
    const n = morphN(o.iconD ?? 1);
    const re = (o.rDot ?? 0.021) * 1.35 * sprd;
    const pulse = 1 + 0.02 * Math.sin(local * 3.1);

    const dots = [];
    const c2 = size / 2;
    let seg = 0;
    let acc = 0;
    for (let k2 = 0; k2 < n; k2++) {
      const target = (k2 / n) * total;
      while (acc + L[seg] < target && seg < M - 1) {
        acc += L[seg];
        seg++;
      }
      const a = pts[seg];
      const b = pts[(seg + 1) % M];
      const f = L[seg] ? Math.min(1, (target - acc) / L[seg]) : 0;
      const x = (a[0] + (b[0] - a[0]) * f) * pulse;
      const y = (a[1] + (b[1] - a[1]) * f) * pulse;
      dots.push({
        x: c2 + x * size,
        y: c2 + y * size,
        z: 0,
        r: Math.max(0.35, re * size),
        white: 0.1
      });
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  /* ── registry + presets (registry.ts, presets.ts) ── */

  const MODE_FRAMES = {
    orbits: frameOrbits,
    globe: frameGlobe,
    rubik: frameRubik,
    wave: frameWave,
    web: frameWeb,
    braid: frameBraid,
    ribbon: frameRibbon,
    // ring shares ribbon's geometry — the faceOn profile flag switches it
    ring: frameRibbon,
    morph: frameMorph
  };

  const STATE_TO_MODE = {
    working: 'orbits',
    searching: 'globe',
    solving: 'rubik',
    listening: 'wave',
    connecting: 'web',
    weaving: 'braid',
    composing: 'ribbon',
    breathing: 'ring',
    shaping: 'morph'
  };

  // The shipped tunings: nine states × two sizes, baked from inkform's
  // tuning session. count/size are multipliers over the base fine
  // profiles; speed multiplies the shared clock.
  const PRESETS = {
    orbits: {
      64: { speed: 1.885, count: 1, size: 1 },
      20: { speed: 3.9, count: 0.238, size: 2.4 }
    },
    globe: {
      64: { speed: 2.015, count: 0.42, size: 1.15, extra: { scanMul: 4.08, dimBase: 0.45 } },
      20: { speed: 2.665, count: 0.105, size: 1.75, extra: { scanMul: 4.335, dimBase: 0.45 } }
    },
    rubik: {
      64: { speed: 1.82, count: 0.35, size: 1.05 },
      20: { speed: 1.95, count: 0.088, size: 1.9 }
    },
    wave: {
      64: { speed: 4.388, count: 0.341, size: 1 },
      20: { speed: 3.998, count: 0.105, size: 1.6 }
    },
    web: {
      64: { speed: 3.315, count: 1.35, size: 0.95 },
      20: { speed: 6.63, count: 0.25, size: 1.52 }
    },
    braid: {
      64: { speed: 1.625, count: 0.5, size: 1 },
      20: { speed: 2.75, count: 0.1125, size: 1.36 }
    },
    ribbon: {
      64: { speed: 2.34, count: 0.25, size: 0.85, extra: { spin: 0, bandMul: 3.9, wobMul: 1 } },
      20: { speed: 3.12, count: 0.051, size: 1.073, extra: { spin: 0, bandMul: 4.94, wobMul: 1 } }
    },
    ring: {
      64: { speed: 3.24, count: 0.25, size: 0.956, extra: { spin: 0, bandMul: 3.627, wobMul: 0.368 } },
      20: { speed: 3.78, count: 0.028, size: 1.622, extra: { spin: 0, bandMul: 3.968, wobMul: 0.565 } }
    },
    morph: {
      64: { speed: 2.405, count: 0.702, size: 0.395, extra: { spread: 1.45 } },
      20: { speed: 2.08, count: 0.53, size: 1.011, extra: { spread: 1.45 } }
    }
  };

  const presetCache = new Map();

  /** Resolve a (state, size) pair to mode + fully-scaled draw options. */
  function resolvePreset(state, size) {
    const key = `${state}-${size}`;
    const hit = presetCache.get(key);
    if (hit) return hit;

    const mode = STATE_TO_MODE[state];
    const preset = PRESETS[mode][size];
    let opts = { ...BASE_PROFILES[mode] };
    if (preset.count !== 1) opts = scaleCounts(opts, preset.count);
    if (preset.size !== 1) opts = scaleRadii(opts, preset.size);
    if (preset.extra) opts = { ...opts, ...preset.extra };

    const resolved = { mode, speed: preset.speed, opts };
    presetCache.set(key, resolved);
    return resolved;
  }

  /** Per-state default aria-labels (overridable via opts.ariaLabel). */
  const LABELS = {
    working: 'Working…',
    searching: 'Searching…',
    solving: 'Solving…',
    listening: 'Listening…',
    connecting: 'Connecting…',
    weaving: 'Weaving…',
    composing: 'Composing…',
    breathing: 'Thinking…',
    shaping: 'Shaping…'
  };

  /* ── theme resolution (theme.ts, sans React) ──
     Ancestor data-theme="dark|light" attr or dark/light class resolved at
     mount; LIVE flips arrive from the one shared observer on <html>'s
     data-theme (the only place TreeMap ever writes a theme) plus the
     prefers-color-scheme subscription for the OS fallback. Pre-resolution
     fallback is dark, matching the app's default theme. */

  function ancestorTheme(el) {
    let node = el;
    while (node) {
      const attr = node.getAttribute('data-theme');
      if (attr === 'dark') return true;
      if (attr === 'light') return false;
      if (node.classList.contains('dark')) return true;
      if (node.classList.contains('light')) return false;
      node = node.parentElement;
    }
    return null;
  }

  function systemDark() {
    return typeof matchMedia === 'undefined' || matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /* ── the vanilla mount: one shared clock, ONE shared rAF loop ──
     Every mounted orb registers in `animating`; the single loop renders
     them all off one performance.now() clock (so instances stay in
     phase) and fully stops the moment the set is empty or the tab is
     hidden. REDUCED users get one static frame and no loop at all. */

  const orbsMounted = new Set(); // every un-destroyed orb
  const orbsAnimating = new Set(); // orbs currently animating
  let orbRaf = 0;
  let orbLooping = false;

  function orbTick() {
    if (!orbLooping) return;
    const now = performance.now() / 1000;
    for (const orb of orbsAnimating) {
      /* FxGoo's degrade contract, applied to the shared loop: one orb
         throwing (a lost 2D context, a future mode bug) must neither
         starve the orbs after it in the set nor re-throw at 60fps —
         drop it from the loop and say so once. */
      try { orb.render(now * orb.effSpeed); }
      catch (err) {
        orbsAnimating.delete(orb);
        console.warn('FxOrbs: orb removed from the loop after a render error', err);
      }
    }
    if (orbsAnimating.size === 0) { orbLooping = false; orbRaf = 0; return; }
    orbRaf = requestAnimationFrame(orbTick);
  }

  function orbStartLoop() {
    if (orbLooping || orbsAnimating.size === 0 || document.hidden) return;
    orbLooping = true;
    orbRaf = requestAnimationFrame(orbTick);
  }

  function orbStopLoop() {
    if (!orbLooping) return;
    orbLooping = false;
    cancelAnimationFrame(orbRaf);
  }

  function orbOnVisibility() {
    if (document.hidden) orbStopLoop();
    else orbStartLoop();
  }

  /* ── one theme observer for every orb ──
     TreeMap flips themes by writing data-theme on <html> and nowhere else,
     so a single observer on that one element's attributes covers every
     mount. The ported per-orb subtree observer re-ran the ancestor walk
     for EVERY class toggle in the app (legend hovers, drop targets, view
     switches) × every live orb — during scans, the busiest moment. */
  const orbReThemers = new Set();
  let orbThemeMo = null;
  function orbWatchTheme(reTheme) {
    orbReThemers.add(reTheme);
    if (!orbThemeMo && typeof MutationObserver !== 'undefined') {
      orbThemeMo = new MutationObserver(() => { for (const fn of orbReThemers) fn(); });
      orbThemeMo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
  }
  function orbUnwatchTheme(reTheme) {
    orbReThemers.delete(reTheme);
    if (orbReThemers.size === 0 && orbThemeMo) { orbThemeMo.disconnect(); orbThemeMo = null; }
  }

  /**
   * Mount an orb into `container`.
   *
   * opts: { state, size (64|20), speed?, ariaLabel?, paused? }
   * returns { setState(s), pause(), resume(), destroy() }
   */
  function mount(container, opts = {}) {
    const state = opts.state ?? 'working';
    const size = opts.size ?? 64;
    const userSpeed = opts.speed ?? 1;
    if (!STATE_TO_MODE[state]) throw new Error(`FxOrbs: unknown state "${state}"`);
    if (size !== 64 && size !== 20) throw new Error(`FxOrbs: size must be 64 or 20, got ${size}`);

    const canvas = document.createElement('canvas');
    canvas.className = 'fx-orb';
    canvas.setAttribute('role', 'img');
    const customLabel = opts.ariaLabel;
    canvas.setAttribute('aria-label', customLabel || LABELS[state]);
    // dpr-correct backing store, capped at 2 like the source library; the
    // pixel-ratio transform is (re)applied on the context every frame
    let dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let mode;
    let modeOpts;
    let destroyed = false;
    let paused = !!opts.paused;

    // resolve AFTER appending, so ancestor data-theme/classes are visible
    let dark = (() => {
      const fromTree = ancestorTheme(canvas);
      return fromTree === null ? systemDark() : fromTree;
    })();

    const orb = {
      effSpeed: 1,
      lastT: 0,
      render(tSec) {
        orb.lastT = tSec;
        // Browser zoom or a drag to a differently-scaled display changes
        // the ratio after mount; re-read it live (as Canvas2D.setup does)
        // and resize the backing store the frame it moves, or the orb
        // renders soft/doubled until remounted. Two comparisons per frame.
        const d = Math.min(2, window.devicePixelRatio || 1);
        if (d !== dpr) {
          dpr = d;
          canvas.width = Math.round(size * d);
          canvas.height = Math.round(size * d);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size, size);
        paintFrame(ctx, MODE_FRAMES[mode](size, tSec, modeOpts), dark);
      }
    };

    const applyState = (s) => {
      const r = resolvePreset(s, size);
      mode = r.mode;
      modeOpts = r.opts;
      orb.effSpeed = r.speed * userSpeed;
      if (!customLabel) canvas.setAttribute('aria-label', LABELS[s]);
    };
    applyState(state);

    // live theme: ancestor attr/class flips + OS scheme switches. Static
    // orbs (REDUCED or paused) repaint their held frame in the new ink.
    const reTheme = () => {
      const fromTree = ancestorTheme(canvas);
      const next = fromTree === null ? systemDark() : fromTree;
      if (next === dark || destroyed) return;
      dark = next;
      orb.render(orb.lastT);
    };
    const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener('change', reTheme);
    orbWatchTheme(reTheme); // the shared <html> data-theme observer

    if (orbsMounted.size === 0) document.addEventListener('visibilitychange', orbOnVisibility);
    orbsMounted.add(orb);

    const stopAnimating = () => {
      orbsAnimating.delete(orb);
      if (orbsAnimating.size === 0) orbStopLoop();
    };
    const startAnimating = () => {
      if (destroyed || REDUCED || paused || !ioVisible) return;
      orbsAnimating.add(orb);
      orbStartLoop();
    };

    // Offscreen pause, per instance (ThinkingOrb.tsx): a hidden panel or a
    // scrolled-away card stops costing frames the moment the browser says
    // so, and resuming re-joins the ONE shared clock — so every orb stays
    // in phase no matter how long it sat parked.
    let ioVisible = true;
    let io = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        ioVisible = entries[entries.length - 1].isIntersecting;
        if (ioVisible) startAnimating(); else stopAnimating();
      });
      io.observe(canvas);
    }

    // Reduced motion → one static, deterministic frame; never animate.
    // t = 0.6 is the library's representative pose — the t = 0 poses are
    // degenerate (morph is a plain circle, the wave is a flat line).
    if (REDUCED) {
      orb.render(0.6);
    } else {
      // paint immediately — no blank canvas before the first rAF, and a
      // paused mount still shows its representative frame
      orb.render((performance.now() / 1000) * orb.effSpeed);
      startAnimating();
    }

    return {
      setState(s) {
        if (destroyed) return;
        if (!STATE_TO_MODE[s]) throw new Error(`FxOrbs: unknown state "${s}"`);
        applyState(s);
        // repaint now in the new mode; the loop (if running) carries on
        orb.render(REDUCED ? 0.6 : (performance.now() / 1000) * orb.effSpeed);
      },
      pause() {
        if (destroyed || paused) return;
        paused = true;
        stopAnimating();
      },
      resume() {
        if (destroyed || !paused) return;
        paused = false;
        startAnimating(); // REDUCED and offscreen orbs stay parked
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        stopAnimating();
        orbsMounted.delete(orb);
        if (orbsMounted.size === 0) document.removeEventListener('visibilitychange', orbOnVisibility);
        mq?.removeEventListener('change', reTheme);
        orbUnwatchTheme(reTheme);
        io?.disconnect();
        canvas.remove();
      }
    };
  }

  return {
    mount,
    // The pure geometry surface, exposed for the extraction tests: the
    // golden-vector suite runs these in Node and compares numbers.
    engine: {
      resolvePreset,
      MODE_FRAMES,
      STATE_TO_MODE,
      PRESETS,
      BASE_PROFILES,
      LABELS,
      finalizeFrame,
      radiusScale,
      scaleCounts,
      scaleRadii
    }
  };
})();
/* ═══ end FX: Thinking Orbs ═══ */

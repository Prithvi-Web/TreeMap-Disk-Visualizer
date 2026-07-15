# TreeMap Liquid Glass UI — Design Spec

**Date:** 2026-07-14
**Goal:** Restyle TreeMap's entire frontend in Apple's Liquid Glass design language — real edge refraction, chromatic aberration, specular highlights, frosted depth — while changing zero backend behavior.

## Why not use liquid-glass-react directly

TreeMap's frontend is a single vanilla HTML/CSS/JS file (`public/index.html`); there is no React and no bundler. `liquid-glass-react` is a React component. Instead we **port its exact rendering technique** (verified working in Chromium, which is what Electron uses):

- A displacement map generated per element size with a rounded-rect SDF "liquid" shader (pure JS canvas port of the library's `ShaderDisplacementGenerator`).
- An SVG filter chain per element: `feImage` (map) → three `feDisplacementMap` passes at offset scales for R/G/B (chromatic aberration) → screen-blend recombine → edge-masked composite so centers stay sharp.
- Applied via `backdrop-filter: url(#lg-f-N) blur(Xpx) saturate(Y%)` — **empirically proven** in this Chromium; (`filter: url()` on the layer does *not* warp the backdrop and is not used).
- Specular ring: masked-gradient border layer with `mix-blend-mode: screen`, angle follows pointer on tracked elements.

Attribution comment in code points to rdev/liquid-glass-react (MIT).

## Glass tiers

| Tier | Class/selector | Treatment | Applied to |
|------|---------------|-----------|------------|
| 1 — Lens | `data-lg` attr + `.lg` styles | Displacement refraction + aberration + blur/saturate + specular ring | header, tabbar, modals, cart dock (tab+panel), selection bar, preview pane, context menu, tooltip, toasts, time slider bar, live feed panel |
| 2 — Frost | existing `.glass` (upgraded CSS only) | Rich blur/saturate, gradient tint, inset specular, deeper shadow; **no displacement** | all dashboard cards, treemap wrap, grid scroll, dup groups, nd clusters, progress cards (incl. every JS-generated `.glass`) |
| 3 — Controls | `.btn`, `.pill`, `.seg`, `.icon-btn`, `.tile`, inputs | Translucent surface, specular top edge, hover glow, `:active` spring scale | every button/pill/segment/input/tile |

Tier 1 elements are floating surfaces where the backdrop actually varies, so refraction is visible and worth the GPU cost; they are also `display:none` when closed (modals, menus, toasts), so idle cost is limited to header/tabbar.

## Engine (vanilla port, ~200 lines, inline in index.html)

- Hidden `<svg><defs id="lgDefs">` before `</body>`.
- `LG.attach(el)`: measure element → generate/cache displacement map (cache key: size rounded to 8px buckets) → build/update `<filter id="lg-f-N">` → set inline `--lg-backdrop: url(#lg-f-N) blur(…) saturate(…)`.
- Per-element options via `data-lg="scale:44 blur:16 sat:180 track"` (`track` = specular angle follows pointer, rAF-throttled).
- `ResizeObserver` per attached element (debounced) — modals/panels resize with content.
- `MutationObserver` on `body` attaches dynamically created `[data-lg]` nodes (toasts).
- CSS fallback: if JS hasn't run, `.lg`'s `::before` still gets plain `blur()+saturate()` — the app never looks broken.
- Area cap ~1.6M px²: oversize elements silently fall back to frost (no displacement).

## Layering per Tier-1 element

- `::before` = warp layer: `backdrop-filter: var(--lg-backdrop)`, tint gradient background, `z-index:-1` under `isolation:isolate`.
- `::after` = specular ring: 1.5px padding-mask gradient, `mix-blend-mode: screen`, plus inset white hairline; angle var `--lg-angle`.
- Content untouched — **no DOM restructuring**, only a class + data attribute on existing elements.

## Token & ambience updates (values only — every existing var name kept)

Canvas code reads `--accent, --tm-canvas-bg, --bg-1, --text-1/2/3, --surface-2, --hairline, --danger` via `cssVar()`; all remain defined on `:root` in both themes. Changes: deeper `--bg-0/1` (near-black blue), lower-alpha `--glass` (real refraction carries more), brighter `--shine`, extra ambient blob + subtle grain overlay, spring easing token `--ease-spring`. Light theme gets equivalent treatment (`overLight` handling: darker tint + softer ring on light backdrop).

## Hard constraints (from codebase audit)

1. **Never rename/remove**: any `id`, functional classes (`.open/.active/.show/.visible/.selected/.on/.out/.hl/.sel/.cartin/.zooming`, `.cc-*`, `.s-*`, `.i-*`, `.bp-*`, `.nd-*`, `.dup-*`, `.clean-*`, `.smart-*`, `.empty-*`, data-* hooks), or the CSS vars listed above.
2. `.growth-proj` JS clobbers `className` — style base class only, no added classes there.
3. Toast exit ≤320ms, preview slide ≤260ms (JS-timed removal); tooltip must be measurable immediately after `display:block` (no position transitions).
4. JS-generated inline styles (bar widths/colors) untouched.
5. No new network origins; everything stays inline in `index.html`.
6. Zero changes to `src/**` (backend). Optional cosmetic: `electron/main.js` `backgroundColor` synced to new `--bg-0`.
7. `prefers-reduced-motion`: disable blob drift, sweeps, springs.

## Verification plan

`npm run dev` → open `127.0.0.1:4280` in Chromium browser pane → exercise: scan a real folder (SSE progress), all 8 views, modals, cart, preview, context menu, toasts, theme toggle, export menu; console+network watched for errors; screenshots dark+light. Then `npm run typecheck` + `npm test` + `npm run app` for the real Electron window. Finish with an adversarial multi-agent review of the diff.

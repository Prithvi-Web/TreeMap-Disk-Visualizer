# src/ui — the frontend, as editable files

`public/index.html` is **generated**. Edit the files here and run:

```
npm run build:ui
```

## Why it ships as one file

`tests/frontendContract.test.ts` forbids external scripts, stylesheets and
fonts. That is what lets the page run from `file://`, out of the portable zip,
and inside Electron with nothing to resolve. Shipping one file is a
distribution constraint — it was never meant to be the editing experience.

So the page is written as ~110 small files and stitched at build time.
`scripts/build-ui.js` concatenates them in `manifest.json` order and does
nothing else: no templating, no minification, no reordering. Every part is a
verbatim slice of the page, which is what makes the guarantee below possible.

## The guarantee

`public/index.html` is **byte-identical** to what these sources build.
`tests/buildUi.test.ts` asserts it, so a hand-edit of the artifact — or a
source edited without a rebuild — fails the suite rather than shipping.

```
node scripts/build-ui.js --check    # prove the artifact matches its sources
```

## Layout

| Directory | What lives there |
|---|---|
| `shell/` | The four fixed pieces: `<head>`, `</style></head><body>`, the opening `<script>`, and the closing tags. |
| `styles/` | The stylesheet, one file per area — tokens, primitives, each view, each FX library's CSS. |
| `markup/` | The body: the sidebar, one file per view, then the modals and docks. |
| `app/` | The application script, cut at its own top-level banner comments. Each FX library (`fx-liquid-goo`, `fx-charts`, `fx-thinking-orbs`, `fx-border-beam`, `fx-rolling-numerals`) is a file of its own. |

Files are numbered in build order. `manifest.json` is the authority — a file
that is not listed there would never ship, so `build-ui` refuses to build
until it is either listed or deleted.

## Two things that will bite you

- **The FX banner comments are test anchors.** `fxCharts`, `fxBeam`, `fxOrbs`,
  `fxGoo` and `fxWiring` slice the built page between exact strings and
  hard-fail if one is renamed. The CSS copies use shorter `═` runs than the JS
  banners on purpose. `buildUi.test.ts` also refuses a part boundary that lands
  inside a block comment.
- **Adding a file means adding it to `manifest.json`**, in the position you
  want it built. Renaming one means renaming it there too.

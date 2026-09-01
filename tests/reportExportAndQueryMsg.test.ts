import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Two defects that both hide behind a screen that LOOKS finished.
 *
 *  1. **Export could unload the whole app.** `downloadReport` was the one
 *     network call in the UI that did not go through `api()`: a bare `<a>`
 *     click at `/api/scan/:scanId/export`. A bare anchor navigates unless the
 *     answer carries `Content-Disposition: attachment`, and that endpoint only
 *     sets the header once the scan has FINISHED — while it is running it
 *     answers `202 {status:'running'}`, and 404/500 answer the flat JSON error
 *     envelope. So Export mid-scan replaced the single-page app with a page of
 *     raw JSON and took the cart, the drill-in and every unsaved thing with it.
 *     Easy to hit, because an already-indexed folder paints instantly from the
 *     index while a real scan runs underneath.
 *
 *  2. **The query message gave advice that cannot work.** It said the undrawn
 *     matches were "deeper than this view draws; zoom in or raise Depth" no
 *     matter WHY they were undrawn. Measured on the live app at the scan root
 *     with `size>1gb`: the API returns 9 and the map draws 8, and the missing
 *     one is the current view root, which has no rectangle and can never get
 *     one. After a drill-in the same sentence is wrong differently —
 *     `/api/query` searches the whole scan, so matches outside the subtree on
 *     screen are not deeper, they are elsewhere, and raising Depth draws
 *     deeper, never wider.
 *
 * Both are pinned against the BUILT artifact, the way every frontend test in
 * this repo is: `public/index.html` is what actually ships.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The source of one named function declaration, by matching braces. */
function fnSource(name: string): string {
  const re = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`);
  const m = re.exec(INDEX);
  assert.ok(m, `function ${name} exists in public/index.html`);
  const start = m!.index;
  const open = INDEX.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  assert.fail(`function ${name} never closes`);
}

/** A statement and everything up to its matching closing brace. */
function bracedFrom(anchor: string): string {
  const start = INDEX.indexOf(anchor);
  assert.notEqual(start, -1, `anchor "${anchor}" exists in public/index.html`);
  const open = INDEX.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  assert.fail(`anchor "${anchor}" never closes`);
}

/* ══════════════════ 1. the report download cannot unload the app ══════════════════ */

type Anchor = {
  href: string;
  download: string | undefined;
  rel: string;
  clicked: number;
  remove(): void;
};

type RunResult = {
  toasts: { msg: string; kind?: string }[];
  asked: string[];
  anchors: Anchor[];
};

/**
 * Drive the SHIPPED `downloadReport` with a canned answer from the shared
 * `api()` wrapper, recording every anchor it builds.
 *
 * The `document` stub only knows how to make anchors and append them; anything
 * else — `location`, `window.open` — is a Proxy that throws, because reaching
 * for one of those is the navigation bug wearing a different hat.
 */
async function runDownloadReport(
  args: [string, string?],
  scanState: Record<string, unknown>,
  answer: unknown | Error,
): Promise<RunResult> {
  const out: RunResult = { toasts: [], asked: [], anchors: [] };
  const trap = new Proxy({}, {
    get() { throw new Error('downloadReport reached for location/window — that is the navigation bug'); },
  });
  const doc = {
    createElement(tag: string) {
      assert.equal(tag, 'a', 'only an anchor is ever created');
      const a: Anchor = {
        href: '', download: undefined, rel: '', clicked: 0,
        remove() { /* detached again; nothing to record */ },
      };
      (a as unknown as { click(): void }).click = () => { a.clicked++; };
      out.anchors.push(a);
      return a;
    },
    body: { appendChild() { /* attached */ } },
  };
  const fn = new Function(
    'state', 'toast', 'api', 'exportFileName', 'document', 'location', 'window',
    `${fnSource('downloadReport')}\nreturn downloadReport;`,
  )(
    scanState,
    (msg: string, kind?: string) => { out.toasts.push({ msg, kind }); },
    async (url: string) => { out.asked.push(url); if (answer instanceof Error) throw answer; return answer; },
    (ext: string) => `treemap-Photos-20260831.${ext}`,
    doc,
    trap,
    trap,
  );
  await fn(...args);
  return out;
}

const READY = { scanId: 'sc1', root: { path: '/r' }, scanning: false };
const DONE = { scanId: 'sc1', status: 'complete' };

/** Every anchor the app builds for a report, and whether it can navigate. */
function clicked(out: RunResult): Anchor[] {
  return out.anchors.filter((a) => a.clicked > 0);
}

test('a scan still in flight is never offered the report at all', () => {
  // Half one: the menu. `canReport` decides whether the CSV/Excel/PDF entries
  // are built at all, and a running scan cannot produce any of them.
  const handler = bracedFrom("$('tmExportBtn').addEventListener('click'");
  const canReport = /const canReport = ([^;]+);/.exec(handler);
  assert.ok(canReport, 'the export menu still computes canReport');
  assert.match(canReport![1], /state\.scanning/,
    'the report entries are gated on no scan being in flight, not just on a scanId');
});

test('the report download refuses to run while this session knows it is scanning', async () => {
  const out = await runDownloadReport(
    ['csv', 'files'],
    { scanId: 'sc1', root: { path: '/r' }, scanning: true },
    DONE,
  );
  assert.equal(out.asked.length, 0, 'nothing is even requested while the scan runs');
  assert.equal(clicked(out).length, 0, 'and nothing is downloaded');
  assert.equal(out.toasts.length, 1, 'the user is told why, rather than nothing happening');
});

test('a scan the SERVER still calls running is toasted, never navigated to', async () => {
  // The exact repro: an already-indexed folder painted a map instantly, so
  // `state.scanning` is false in this session while a real scan is still
  // walking the tree underneath. Only the server knows, so it is asked.
  const out = await runDownloadReport(['pdf'], READY, { scanId: 'sc1', status: 'running' });
  assert.equal(clicked(out).length, 0, 'a running scan produces no download at all');
  assert.ok(out.toasts.some((t) => t.kind === 'error'), 'the user is told, in an error toast');
});

test('a failed or evicted scan is spoken in the server’s own words', async () => {
  const err = Object.assign(new Error('No such scan'), { code: 'SCAN_NOT_FOUND', status: 404 });
  const out = await runDownloadReport(['csv', 'folders'], READY, err);
  assert.equal(clicked(out).length, 0);
  const said = out.toasts.map((t) => t.msg).join(' | ');
  assert.match(said, /No such scan/, 'the envelope’s message reaches the user instead of the address bar');
});

test('a scan that ended in error never reaches the export endpoint', async () => {
  const out = await runDownloadReport(['csv', 'files'], READY, { scanId: 'sc1', status: 'error' });
  assert.equal(clicked(out).length, 0, 'there is nothing to report on');
  assert.ok(out.toasts.some((t) => t.kind === 'error'));
});

/**
 * The structural half, and the one that matters most: even past a clean
 * preflight the anchor must be UNABLE to navigate. A same-origin `<a download>`
 * saves the response whatever comes back — status, content type and
 * Content-Disposition stop mattering. Without the attribute this anchor is
 * the original defect, so its presence is the invariant, not the wording of
 * any toast around it.
 */
test('the report anchor carries a download attribute, so it cannot navigate', async () => {
  const out = await runDownloadReport(['xlsx', 'files'], READY, DONE);
  const fired = clicked(out);
  assert.equal(fired.length, 1, 'the happy path still downloads');
  assert.ok(fired[0].download, 'the anchor has a download attribute — this is what forbids navigation');
  assert.match(fired[0].download!, /\.xlsx$/, 'and it names the file the format the user asked for');
  assert.equal(fired[0].href, '/api/scan/sc1/export?format=xlsx&mode=files');
  assert.deepEqual(out.asked, ['/api/scan/sc1/stats'], 'the readiness check goes through the shared wrapper');
});

test('no report format is ever handed a bare, navigable anchor', async () => {
  // A per-format regression net: it only takes one branch forgetting the
  // attribute to bring the whole defect back for that one menu entry.
  const formats: [string, string?][] = [
    ['csv', 'files'], ['csv', 'folders'], ['xlsx', 'files'], ['xlsx', 'folders'], ['pdf'],
  ];
  for (const args of formats) {
    const out = await runDownloadReport(args, READY, DONE);
    for (const a of out.anchors) {
      assert.ok(a.download, `${args.join(' ')} built an anchor with no download attribute`);
    }
  }
});

/* ══════════════════ 2. the query message tells the truth about the gap ══════════════════ */

type QueryMsg = (found: number, drawn: number, paths: string[], viewRoot: string | null) => string;

/** Lifted per test, so one missing function fails a test rather than the file. */
function tmQueryMsg(...args: Parameters<QueryMsg>): string {
  const fn = new Function(
    `${fnSource('tmIsInside')}\n${fnSource('tmUndrawnBreakdown')}\n${fnSource('tmUndrawnMessage')}\nreturn tmUndrawnMessage;`,
  )() as QueryMsg;
  return fn(...args);
}

/** The single advice clause that is only ever true for a genuine depth gap. */
const DEPTH_ADVICE = /raise Depth/i;

test('the view root itself is named as the root, and never blamed on Depth', () => {
  // Measured on the live app: at the scan root, `size>1gb` returns 9 and the
  // map draws 8. The ninth is the root folder, which IS the map — it has no
  // rectangle and no Depth setting will ever give it one.
  const hits = ['/r', '/r/a', '/r/b', '/r/c', '/r/d', '/r/e', '/r/f', '/r/g', '/r/h'];
  const msg = tmQueryMsg(9, 8, hits, '/r');
  assert.match(msg, /9 matches — 8 shown here/, 'both numbers are still stated');
  assert.doesNotMatch(msg, DEPTH_ADVICE,
    'raising Depth cannot draw the view root, so it is not suggested');
  assert.match(msg, /this folder itself/i, 'the message says what the missing one actually is');
});

test('matches outside the drilled-in folder are called elsewhere, not deeper', () => {
  // /api/query searches the WHOLE scan. After drilling into /r/sub, hits in
  // /r/other are not deeper than this view — they are outside it, and Depth
  // draws deeper, never wider.
  const hits = ['/r/sub/x', '/r/other/y', '/r/other/z'];
  const msg = tmQueryMsg(3, 1, hits, '/r/sub');
  assert.doesNotMatch(msg, DEPTH_ADVICE,
    'nothing is deeper here, so the Depth advice must be absent');
  assert.match(msg, /outside this folder|elsewhere/i,
    'the message says the matches are somewhere else in the scan');
  assert.match(msg, /\b2\b/, 'and how many');
});

test('a genuine depth gap still gets the Depth advice', () => {
  const hits = ['/r/a', '/r/b/deep1', '/r/b/deep2', '/r/b/deep3'];
  const msg = tmQueryMsg(4, 1, hits, '/r');
  assert.match(msg, DEPTH_ADVICE, 'this is the one case where raising Depth helps');
  assert.match(msg, /3 are deeper/, 'and it counts them');
});

test('a mixed gap names every case it actually has', () => {
  const hits = ['/r/sub', '/r/sub/a', '/r/sub/b/deep', '/r/elsewhere/c'];
  const msg = tmQueryMsg(4, 1, hits, '/r/sub');
  assert.match(msg, /this folder itself/i, 'the view root is one of them');
  assert.match(msg, /outside this folder|elsewhere/i, 'so is a match in another subtree');
  assert.match(msg, DEPTH_ADVICE, 'and one really is deeper');
});

/**
 * The invariant behind all four: the Depth advice appears if and only if at
 * least one undrawn match is inside the current view and below what it draws.
 * Anchoring to the wording of any one message would let the next edit put the
 * sentence back on a case it cannot help.
 */
test('the Depth advice appears exactly when raising Depth could help', () => {
  const cases: { hits: string[]; root: string; drawn: number; deeper: boolean }[] = [
    { hits: ['/r'], root: '/r', drawn: 0, deeper: false },
    { hits: ['/r', '/r/a'], root: '/r', drawn: 1, deeper: false },
    { hits: ['/r/a/b'], root: '/r', drawn: 0, deeper: true },
    { hits: ['/other/a'], root: '/r', drawn: 0, deeper: false },
    { hits: ['/r/a', '/other/b'], root: '/r', drawn: 1, deeper: false },
    { hits: ['/r/a', '/r/b', '/other/c'], root: '/r', drawn: 1, deeper: true },
    // Windows paths go through the same separator rule as everything else.
    { hits: ['C:\\r\\sub\\a'], root: 'C:\\r', drawn: 0, deeper: true },
    { hits: ['C:\\r'], root: 'C:\\r', drawn: 0, deeper: false },
  ];
  for (const c of cases) {
    const msg = tmQueryMsg(c.hits.length, c.drawn, c.hits, c.root);
    assert.equal(DEPTH_ADVICE.test(msg), c.deeper,
      `${JSON.stringify(c.hits)} under ${c.root} with ${c.drawn} drawn → ${msg}`);
  }
});

test('the wrong sentence is gone from the shipped query handler', () => {
  // The old text blamed Depth unconditionally, and it is the whole defect.
  const run = fnSource('tmRunGrammarQuery');
  assert.ok(!/The rest are deeper than this view draws/.test(run),
    'the unconditional "the rest are deeper" sentence is no longer shipped');
  assert.match(run, /tmUndrawnMessage\s*\(/,
    'the handler builds its message through the classifier instead');
});

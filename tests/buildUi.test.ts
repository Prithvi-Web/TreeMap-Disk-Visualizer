import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * The single-file page is BUILT from src/ui/**.
 *
 * The app ships as one file because frontendContract forbids external scripts,
 * styles and fonts — it has to run from file://, from a portable zip and inside
 * Electron with nothing to resolve. Editing 29k lines as one file is the price,
 * and scripts/build-ui.js is how that price is refunded: the sources are ~110
 * small files and the build concatenates them.
 *
 * The build is a concatenation and nothing else, so these tests can hold the
 * strongest possible contract — the shipped artifact is BYTE-IDENTICAL to what
 * the sources produce. Every other test in this suite reads public/index.html,
 * so if that ever stopped being true they would all be testing a stale file.
 */

const repoRoot = path.join(__dirname, '..');
const uiDir = path.join(repoRoot, 'src', 'ui');
const manifest = JSON.parse(readFileSync(path.join(uiDir, 'manifest.json'), 'utf8')) as {
  output: string;
  parts: string[];
};

test('the shipped page is exactly what src/ui builds — byte for byte', () => {
  const built = manifest.parts
    .map((rel) => readFileSync(path.join(uiDir, rel), 'utf8'))
    .join('\n');
  const shipped = readFileSync(path.join(repoRoot, manifest.output), 'utf8');
  assert.equal(
    built.length,
    shipped.length,
    `${manifest.output} is ${shipped.length} bytes but its sources build ${built.length} — ` +
      'it was edited directly, or a source changed without `npm run build:ui`',
  );
  assert.equal(built, shipped, `${manifest.output} has drifted from src/ui`);
});

test('every source file ships, and no file ships twice', () => {
  const listed = manifest.parts;
  assert.equal(new Set(listed).size, listed.length, 'a part is listed twice');

  const onDisk: string[] = [];
  for (const dir of readdirSync(uiDir)) {
    const sub = path.join(uiDir, dir);
    if (!statSync(sub).isDirectory()) continue;
    for (const name of readdirSync(sub)) onDisk.push(`${dir}/${name}`);
  }
  const missing = onDisk.filter((f) => !listed.includes(f));
  assert.deepEqual(missing, [], 'these source files are not in the manifest, so they would never ship');
});

/**
 * The FX sections are extracted by their banner comments — fxCharts, fxBeam,
 * fxOrbs, fxGoo and fxWiring all slice the built file between exact strings and
 * HARD-FAIL if one is renamed. A split that cut through a banner, or a part
 * boundary that landed mid-comment, would break them in a way that reads as an
 * unrelated failure, so the boundaries are held here too.
 */
test('no part boundary cuts through an FX banner', () => {
  for (const rel of manifest.parts) {
    const body = readFileSync(path.join(uiDir, rel), 'utf8');
    const opens = (body.match(/\/\*/g) || []).length;
    const closes = (body.match(/\*\//g) || []).length;
    assert.equal(opens, closes, `${rel} ends inside a block comment — the cut landed mid-banner`);
  }
});

/**
 * The image has to be able to run the build it invokes.
 *
 * The Docker build stage compiles from a partial checkout, and it copied only
 * package.json, tsconfig.json and src/ — so `RUN npm run build` died on a
 * missing module, and had done since before the stitch step existed
 * (`copy-assets.js` was already unreachable). Derived from the build script
 * rather than written down, so a fourth step cannot be added without either
 * copying what it needs or failing here.
 */
test('the Docker build stage copies everything npm run build reaches for', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const dockerfile = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
  const buildStage = dockerfile.slice(0, dockerfile.indexOf('# ---- runtime'));

  const needed = new Set<string>();
  for (const m of String(pkg.scripts.build).matchAll(/node\s+([\w.-]+)\//g)) needed.add(m[1]);
  assert.ok(needed.size > 0, 'the build script runs at least one local script');

  for (const dir of needed) {
    assert.match(
      buildStage,
      new RegExp(`^COPY ${dir}\\b`, 'm'),
      `npm run build runs a script from ${dir}/, so the build stage must COPY it`,
    );
  }
});

/**
 * The same stage compiles src/, and src/ reaches outside itself: the native
 * module's type declarations (`native/index.d.ts`, imported by the engine and
 * budget services since 18 Sep 2026) and package.json. A file the compiler
 * needs that the stage never copied is a TS2307 in an image build no workflow
 * runs. Derived from the imports, so the next one cannot be missed either.
 */
test('the Docker build stage copies every file outside src/ that src/ imports', () => {
  const dockerfile = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
  const buildStage = dockerfile.slice(0, dockerfile.indexOf('# ---- runtime'));
  const copied = [...buildStage.matchAll(/^COPY (?!--)(.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/).slice(0, -1));
  const src = path.join(repoRoot, 'src');
  const outside = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.ts')) continue;
      for (const m of readFileSync(full, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)'(\.{1,2}\/[^']+)'/g)) {
        const target = path.resolve(path.dirname(full), m[1]);
        if (!path.relative(src, target).startsWith('..')) continue;
        const file = ['', '.d.ts', '.ts', '.js', '.json'].map((ext) => target + ext).find((f) => { try { return statSync(f).isFile(); } catch { return false; } });
        assert.ok(file, `${path.relative(repoRoot, full)} imports ${m[1]}, which is not a file`);
        outside.add(path.relative(repoRoot, file!).split(path.sep).join('/'));
      }
    }
  };
  walk(src);
  assert.ok(outside.has('native/index.d.ts') && outside.has('package.json'), `the scan finds what src/ imports from outside it: ${[...outside].join(', ')}`);
  for (const file of outside) {
    assert.ok(
      copied.some((c) => { const from = c.replace(/^\.\//, '').replace(/\/$/, ''); return file === from || file.startsWith(`${from}/`); }),
      `src/ imports ${file}, so the build stage must COPY it (copied: ${copied.join(', ')})`,
    );
  }
});

/**
 * Whether `.dockerignore` keeps `rel` (a path from the context root, `/`-separated) out of the build
 * context, read as Docker reads it: each line a pattern from the root, `*` and `?` within one name, `**`
 * across names, `!` re-including, the last line that matches deciding, and a line that matches a
 * folder matching everything in it. Character classes (`[…]`) and `\` escapes are not interpreted, so
 * a line using either throws, naming itself: read as literal text it would match nothing, and a
 * pattern Docker honours would slip past every check built on this (review F1.4).
 */
function dockerIgnores(lines: string[], rel: string): boolean {
  const rules = lines
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      if (/[[\\]/.test(line)) {
        throw new Error(`.dockerignore line "${line}" uses a character class or an escape, which dockerIgnores() does not interpret — teach it them before adding the line`);
      }
      const negated = line.startsWith('!');
      const pattern = path.posix.normalize((negated ? line.slice(1) : line).trim().replace(/^\/+/, '')).replace(/\/+$/, '');
      let re = '';
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*' && pattern[i + 1] === '*') {
          i++;
          if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
        } else if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
      return { negated, re: new RegExp(`^${re}$`) };
    });
  const parts = rel.split('/');
  const selfAndFolders = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  let ignored = false;
  for (const rule of rules) if (selfAndFolders.some((p) => rule.re.test(p))) ignored = !rule.negated;
  return ignored;
}

/**
 * The COPY lines above are only half of what reaches the stage: `.dockerignore` filters the build
 * context before any of them runs, so a pattern over a file the stage copies — or over anything inside
 * a folder it copies, src/ui say — fails `npm run build` in the image however right the COPY lines are.
 * And tsc compiles what tsconfig.json includes, so every root it names must be copied too. Read from
 * the three files, so a new pattern, a new COPY or a new include root cannot slip past (the LEFT brief,
 * item 3: the stage once lacked native/index.d.ts, and nothing that ran said so).
 */
test('.dockerignore keeps out nothing the Docker build stage copies, and the stage copies every root tsconfig compiles', () => {
  const dockerfile = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
  const buildStage = dockerfile.slice(0, dockerfile.indexOf('# ---- runtime'));
  const copied = [...buildStage.matchAll(/^COPY (?!--)(.+)$/gm)]
    .flatMap((m) => m[1].trim().split(/\s+/).slice(0, -1))
    .map((c) => c.replace(/^\.\//, '').replace(/\/$/, ''));
  const ignore = readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8').split('\n');

  // Controls: the reading above finds the lines that matter, and keeps out what it should — the
  // dependencies the stage installs itself, and the native build's output and prebuilt module.
  assert.deepEqual(
    ['node_modules/express/index.js', 'dist/index.js', 'native/treemap-core/target/release/libx.rlib', 'native/prebuilt/darwin-arm64/treemap_core.node']
      .filter((p) => !dockerIgnores(ignore, p)),
    [],
    'the build context leaves out node_modules, dist and the native build output',
  );
  assert.equal(dockerIgnores(['docs', '!docs/keep.md'], 'docs/keep.md'), false, 'control: a later ! line re-includes');
  assert.equal(dockerIgnores(['**/*.map'], 'src/a/b.js.map'), true, 'control: ** crosses folders');
  assert.equal(dockerIgnores(['*.log'], 'src/x.log'), false, 'control: * stays in one name, from the root');
  // A line this reading cannot interpret fails here, naming itself, rather than being read as literal
  // text that matches nothing: Docker honours `[s]rc` and `sr\c` as `src`, so either one would keep src/
  // out of the image while the check below stayed green (review F1.4).
  for (const unread of ['[s]rc', 's[r]c', 'native/index.d.t[s]', 'src/ui/[0-9]*', 'sr\\c', '!src/[a]']) {
    assert.throws(
      () => dockerIgnores([unread], 'src/index.ts'),
      (e: Error) => e.message.includes(`"${unread}"`) && /character class or an escape/.test(e.message),
      `a "${unread}" line is refused by name, not read as a literal`,
    );
  }
  for (const needed of ['package.json', 'package-lock.json', 'tsconfig.json', 'scripts', 'src', 'native/index.d.ts']) {
    assert.ok(copied.includes(needed), `control: the build stage copies ${needed} (copied: ${copied.join(', ')})`);
  }

  const kept: string[] = [];
  const dropped: string[] = [];
  const visit = (rel: string): void => {
    const full = path.join(repoRoot, ...rel.split('/'));
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full)) visit(`${rel}/${name}`);
      return;
    }
    (dockerIgnores(ignore, rel) ? dropped : kept).push(rel);
  };
  for (const source of copied) visit(source);
  const visited = [...kept, ...dropped];
  assert.ok(visited.includes('src/ui/manifest.json') && visited.includes('native/index.d.ts'), 'control: the walk reached inside every source');
  assert.deepEqual(dropped, [], 'the build stage copies these, and .dockerignore keeps them out of the context');

  const tsconfig = JSON.parse(readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf8')) as { include: string[] };
  for (const include of tsconfig.include) {
    // The literal folders a pattern starts with: src/**/*.ts compiles from src.
    const root = include.split('/').filter((part, i, all) => all.slice(0, i + 1).every((p) => !/[*?[{]/.test(p))).join('/');
    assert.ok(
      copied.some((c) => root === c || root.startsWith(`${c}/`)),
      `tsconfig.json compiles ${include}, so the build stage must COPY ${root || 'the folder it names'} (copied: ${copied.join(', ')})`,
    );
  }
});

test('the image takes the generated page from the stage that built it', () => {
  const dockerfile = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
  const runtime = dockerfile.slice(dockerfile.indexOf('# ---- runtime'));
  assert.match(
    runtime,
    /^COPY --from=build \/app\/public \.\/public$/m,
    'public/index.html is generated — copying it from the host could ship a stale page',
  );
});

/* The guard a person actually relies on: running the real script must AGREE
   that the tree is consistent. Asserting on the script's source text instead
   would pass on a comment and fail on a reworded one. */
test('build-ui --check agrees the committed artifact matches its sources', () => {
  const out = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-ui.js'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.match(out, /matches its sources/);
});

/**
 * A NUL in an HTML document is a parse error, and the parser does not keep it:
 * in script data U+0000 is replaced with U+FFFD, so the string the browser
 * runs is not the string the source declares. The tooltip cache key used raw
 * C0 bytes as field separators — they worked, but only because the accident
 * (NUL becoming U+FFFD) still separated fields, and the artifact was "binary"
 * to grep, diff and every other line-oriented tool in the repo.
 *
 * Separators are still legitimate; they belong in the source as escapes.
 */
test('the shipped page carries no control characters the HTML parser would rewrite', () => {
  const shipped = readFileSync(path.join(repoRoot, manifest.output));
  const offenders: string[] = [];
  for (let i = 0; i < shipped.length; i++) {
    const b = shipped[i];
    if (b === 9 || b === 10 || b === 13) continue; // tab, LF, CR are ordinary text
    if (b < 0x20 || b === 0x7f) {
      const line = shipped.subarray(0, i).toString('utf8').split('\n').length;
      offenders.push(`0x${b.toString(16).padStart(2, '0')} at byte ${i} (line ${line})`);
      if (offenders.length >= 5) break;
    }
  }
  assert.deepEqual(offenders, [],
    'write a separator as an escape (\\u0000) so the byte never reaches the parser');
});

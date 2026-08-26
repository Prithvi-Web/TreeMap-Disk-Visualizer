import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { parse } from '../src/services/query/parse';
import { toSql } from '../src/services/query/toSql';
import { evaluate, type EvalNode } from '../src/services/query/evaluate';
import type { Ast } from '../src/services/query/types';

/**
 * SQL pushdown (v4 §2.2).
 *
 * The property this file exists to prove, against a **real SQLite**, is
 * soundness: the WHERE clause the planner emits must match a **superset** of
 * the rows the query wants, never a subset. The post-filter can remove extras;
 * it cannot recover rows the SQL already excluded. A subset bug produces
 * silently missing search results — no error, no warning, just a file the user
 * knows is there and cannot find.
 *
 * Structural assertions about the AND/OR/NOT algebra would be easy to write
 * and easy to get wrong in the same way the code is wrong. So instead the
 * corpus below runs each query twice — once through the evaluator, once
 * through SQLite — and compares the sets. That is a test of the thing itself
 * rather than of my reasoning about it.
 */

/* ------------------------------ the fixture ------------------------------ */

interface Row extends EvalNode { id: number }

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 15);

function makeRows(): Row[] {
  const spec: [string, number, boolean, number, number][] = [
    // name, size, isDir, ageDays, depth
    ['holiday.mp4', 2_000_000_000, false, 400, 2],
    ['clip.mp4', 50_000_000, false, 10, 2],
    ['movie.mov', 3_000_000_000, false, 900, 1],
    ['notes.txt', 1_200, false, 5, 1],
    ['archive.zip', 700_000_000, false, 200, 3],
    ['photo.JPG', 4_000_000, false, 30, 4],
    ['no-extension', 900, false, 1, 1],
    ['.gitignore', 100, false, 60, 1],
    ['archive.', 50, false, 60, 2],
    ['node_modules', 4_000_000_000, true, 3, 1],
    ['src', 900_000, true, 2, 1],
    ['empty-dir', 0, true, 500, 2],
    ['Report Final.pdf', 12_000_000, false, 120, 2],
    ['report-draft.pdf', 8_000, false, 800, 3],
    ['a%b_c.txt', 10, false, 7, 2],       // LIKE metacharacters in the name
    ["quote'name.txt", 20, false, 7, 2],  // a quote, to catch naive escaping
    ['big.iso', 9_000_000_000, false, 1000, 1],
    ['tiny.log', 1, false, 0, 5],
  ];
  return spec.map(([name, size, isDir, ageDays, depth], i) => ({
    id: i + 1,
    name,
    path: `/root/${name}`,
    size,
    isDir,
    mtimeMs: NOW - ageDays * DAY,
    depth,
  }));
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot >= name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** A table with the index's real column names, so the SQL under test is the SQL that ships. */
function makeDb(rows: Row[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE nodes (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, ext TEXT NOT NULL DEFAULT '',
    is_dir INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0
  )`);
  const insert = db.prepare('INSERT INTO nodes (id, name, ext, is_dir, size, mtime) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of rows) {
    insert.run(r.id, r.name, r.isDir ? '' : extensionOf(r.name), r.isDir ? 1 : 0, r.size, r.mtimeMs);
  }
  return db;
}

const HOME = '/home/test';

function trueMatches(ast: Ast, rows: Row[]): Set<number> {
  const out = new Set<number>();
  for (const node of rows) {
    if (evaluate(ast, { node, facts: {}, now: NOW }, HOME)) out.add(node.id);
  }
  return out;
}

function sqlMatches(db: Database.Database, ast: Ast, rows: Row[]): Set<number> {
  // The SAME `now` the evaluator uses — the two halves of a query must
  // agree on the instant, or an age comparison disagrees at its boundary.
  const plan = toSql(ast, NOW);
  // No pushable fragment means "the index cannot narrow this at all", which is
  // trivially a superset: every row is a candidate.
  if (!plan.where) return new Set(rows.map((r) => r.id));
  const stmt = db.prepare(`SELECT id FROM nodes n WHERE ${plan.where.sql}`);
  return new Set((stmt.all(...plan.where.params) as { id: number }[]).map((r) => r.id));
}

/**
 * Queries with NO facts in them.
 *
 * Fact-bound terms are deliberately excluded here: the evaluator returns false
 * for an unfetched fact, so `size>1gb or git:dirty` would have a "true" set
 * that is artificially small and the comparison would prove nothing. Their
 * pushdown behaviour (always null, always post-filtered) is asserted
 * separately below.
 */
const CORPUS = [
  '', 'holiday', '*.mp4', '.mp4', 'MP4', 'report',
  'size>1gb', 'size<1000', 'size>=2000000000', 'size<=50', 'size=100',
  'ext:mp4', 'ext:mp4,mov', 'ext:zip,iso,pdf', 'ext:jpg',
  'name:report', 'name:archive', 'name:a%b', 'name:_c', "name:quote'name",
  'type:file', 'type:dir',
  'modified<2025-01-01', 'modified>2025-06-01', 'modified>=2026-01-01',
  'modified>90d', 'modified<30d', 'modified>=1y', 'modified<=2y', 'modified>2y',
  'size>1gb ext:mp4', 'size>1gb type:file', 'ext:mp4 ext:mov',
  'size>1gb or ext:zip', 'ext:mp4 or ext:mov', '*.mp4 or *.mov',
  '-ext:mp4', '-type:dir', '-size>1gb', '-name:report',
  '-(ext:mp4 or ext:mov)', '-(size>1gb type:file)',
  'size>1gb (ext:mp4 or ext:mov)', '(size>1gb or size<100) type:file',
  'size>100mb -ext:mp4', 'type:file -name:report -ext:zip',
  // Terms SQL cannot express, mixed with terms it can.
  'size>1gb depth<=2', 'depth<=2', 'path:root', 'in:/root',
  'size>1gb path:root', 'size>1gb or depth<=2', '-depth<=2',
  '-(size>1gb depth<=2)', 'empty:yes', 'size>1gb empty:yes',
] as const;

/* ------------------------------ the proof ------------------------------ */

test('the pushed SQL always matches a SUPERSET of the real answer', () => {
  const rows = makeRows();
  const db = makeDb(rows);
  try {
    for (const q of CORPUS) {
      const parsed = parse(q);
      assert.equal(parsed.ok, true, `corpus query failed to parse: ${q}`);
      const ast = (parsed as { ok: true; ast: Ast }).ast;

      const truth = trueMatches(ast, rows);
      const sql = sqlMatches(db, ast, rows);

      for (const id of truth) {
        // The failure this catches: a row the user asked for that the SQL
        // already threw away. The post-filter cannot bring it back, so it
        // simply never appears — no error, no warning.
        assert.ok(sql.has(id), `"${q}" — SQL dropped row ${id} (${rows[id - 1].name}) that genuinely matches`);
      }
    }
  } finally {
    db.close();
  }
});

test('an "exact" plan matches the real answer precisely, not merely a superset', () => {
  // `exact` is what licenses pushing a NOT. If a plan claims exactness it did
  // not have, every negation above it silently drops rows.
  const rows = makeRows();
  const db = makeDb(rows);
  try {
    let exactSeen = 0;
    for (const q of CORPUS) {
      const parsed = parse(q);
      const ast = (parsed as { ok: true; ast: Ast }).ast;
      const plan = toSql(ast, NOW);
      if (!plan.where || !plan.where.exact) continue;
      exactSeen++;
      assert.deepEqual(
        [...sqlMatches(db, ast, rows)].sort((a, b) => a - b),
        [...trueMatches(ast, rows)].sort((a, b) => a - b),
        `"${q}" claims exact but does not match the evaluator`,
      );
    }
    assert.ok(exactSeen >= 20, `expected many exact plans, saw ${exactSeen}`);
  } finally {
    db.close();
  }
});

/* ------------------------------ the algebra ------------------------------ */

function plan(q: string) {
  const parsed = parse(q);
  assert.equal(parsed.ok, true, q);
  return toSql((parsed as { ok: true; ast: Ast }).ast, NOW);
}

test('AND may drop an unpushable side, and stops being exact when it does', () => {
  const both = plan('size>1gb ext:mp4');
  assert.ok(both.where);
  assert.equal(both.where!.exact, true);
  assert.deepEqual(both.postFiltered, []);

  const partial = plan('size>1gb depth<=2');
  assert.ok(partial.where, 'the pushable half is still pushed — dropping a conjunct widens, which is safe');
  assert.match(partial.where!.sql, /n\.size > \?/);
  assert.doesNotMatch(partial.where!.sql, /depth/);
  assert.equal(partial.where!.exact, false, 'and the result is no longer exact');
  assert.deepEqual(partial.postFiltered, ['depth']);
});

test('OR is pushed only when BOTH sides are pushable', () => {
  const both = plan('size>1gb or ext:zip');
  assert.ok(both.where);
  assert.match(both.where!.sql, /OR/);

  // Keeping one branch of an OR would NARROW the result and lose real rows.
  const half = plan('size>1gb or depth<=2');
  assert.equal(half.where, null, 'an OR with an unpushable branch must not be pushed at all');
  assert.deepEqual(half.postFiltered, ['depth']);
});

test('NOT is pushed only over an exactly-expressible operand', () => {
  const exact = plan('-ext:mp4');
  assert.ok(exact.where);
  assert.match(exact.where!.sql, /^NOT \(/);
  assert.equal(exact.where!.exact, true);

  // Negating a WIDENED set gives a NARROWER one — rows that should match
  // would vanish. This is the subtlest soundness rule in the planner.
  const widened = plan('-(size>1gb depth<=2)');
  assert.equal(widened.where, null, 'a NOT over an inexact fragment must not be pushed');

  const unpushable = plan('-depth<=2');
  assert.equal(unpushable.where, null);
});

test('every fact-bound field is post-filtered, and named with a reason', () => {
  for (const [q, field] of [
    ['used>1y', 'used'], ['used:never', 'used'], ['elsewhere:proven', 'elsewhere'],
    ['git:pushed', 'git'], ['backup:yes', 'backup'], ['cloud:synced', 'cloud'],
    ['score>70', 'score'], ['dupe:yes', 'dupe'], ['created<2y', 'created'],
    ['path:x', 'path'], ['in:/x', 'in'], ['depth<=2', 'depth'], ['empty:yes', 'empty'],
  ] as const) {
    const p = plan(q);
    assert.equal(p.where, null, `${q} must not be pushed to SQL`);
    assert.deepEqual(p.postFiltered, [field], q);
  }
});

test('an exact-age comparison is not pushed, because it is a moving target', () => {
  // `modified=90d` would need mtime to equal a millisecond that has already
  // passed by the time the query runs. Post-filtering is the honest answer.
  const p = plan('modified=90d');
  assert.equal(p.where, null);
  assert.deepEqual(p.postFiltered, ['modified']);
});

/* ------------------------------ injection ------------------------------ */

test('nothing user-supplied reaches the SQL string — only bound parameters', () => {
  const attacks = [
    "name:'; DROP TABLE nodes; --",
    'name:" OR 1=1 --',
    "name:x' OR '1'='1",
    'name:%',
    'name:_',
    "name:\\",
    'ext:mp4);DROP TABLE nodes;--',
    'in:/x\'; DELETE FROM nodes; --',
    "size>1gb name:'--",
    'name:UNION SELECT * FROM nodes',
  ];
  const rows = makeRows();
  const db = makeDb(rows);
  try {
    for (const q of attacks) {
      const parsed = parse(q);
      if (!parsed.ok) continue; // refused at the door is also fine
      const p = toSql((parsed as { ok: true; ast: Ast }).ast, NOW);
      if (!p.where) continue;

      // Every value must be bound, so the SQL text contains no user data.
      for (const param of p.where.params) {
        if (typeof param !== 'string') continue;
        const bare = param.replace(/^%|%$/g, '').replace(/\\(.)/g, '$1');
        if (bare.length < 4) continue;
        assert.ok(!p.where.sql.includes(bare), `"${q}" leaked "${bare}" into the SQL text`);
      }

      // And it must actually run without destroying anything.
      db.prepare(`SELECT id FROM nodes n WHERE ${p.where.sql}`).all(...p.where.params);
      const remaining = db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number };
      assert.equal(remaining.c, rows.length, `"${q}" changed the table`);
    }
  } finally {
    db.close();
  }
});

test('LIKE metacharacters in a search term are escaped, not honoured', () => {
  const rows = makeRows();
  const db = makeDb(rows);
  try {
    // `name:%` must find the file literally containing a percent sign, not
    // every file — an unescaped LIKE wildcard would match everything and look
    // like a working search.
    const p = plan('name:%');
    const hits = sqlMatches(db, (parse('name:%') as { ok: true; ast: Ast }).ast, rows);
    assert.ok(p.where!.sql.includes("ESCAPE '\\'"), 'the LIKE carries its escape clause');
    assert.deepEqual([...hits], [15], 'only a%b_c.txt contains a literal %');

    const underscore = sqlMatches(db, (parse('name:_c') as { ok: true; ast: Ast }).ast, rows);
    assert.deepEqual([...underscore], [15], '_ is a literal underscore, not "any character"');
  } finally {
    db.close();
  }
});

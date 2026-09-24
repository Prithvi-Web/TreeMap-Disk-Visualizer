import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ORACLE_PATH, oracleText } from './fixtures/storeDeriveOracle';

/**
 * The native store's Rust tests read the extension, container kind and hidden
 * flag `statToInput` gives each of 12,535 ASCII names from a committed file
 * (`native/treemap-core/crates/tm-store/tests/fixtures/derive-oracle.tsv`).
 * The file is only evidence while it is what the TypeScript answers today.
 */
test('the committed store oracle is what statToInput answers today', () => {
  const committed = fs.readFileSync(ORACLE_PATH, 'utf8');
  const today = oracleText();
  const lines = today.split('\n').length - 1;
  assert.ok(lines > 12_000, `${lines} names`);
  assert.ok(
    committed === today,
    `the oracle is stale: regenerate it with \`npx tsx tests/fixtures/storeDeriveOracle.ts\` and commit it (${committed.length} bytes committed, ${today.length} today)`,
  );
});

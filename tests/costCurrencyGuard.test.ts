import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, isCurrency, type CostCurrency } from '../src/services/costIntelligence';

/**
 * §C1 — the currency guard, as a security question rather than a typing one.
 *
 * `isCurrency` is the ONLY thing standing between `?currency=` on
 * GET /api/cost/estimate and two plain object literals (the rate table and the
 * symbol table) that are indexed by the value it approves. A membership test
 * written with `in` walks the prototype chain, so 'constructor', 'toString',
 * 'valueOf' and friends all answer true, sail through the guard, and index the
 * tables to a *function* — which JSON.stringify drops entirely. The live server
 * answered 200 with {"currency":"constructor"} and no symbol and no rate.
 *
 * The invariant these tests hold is membership, not spelling: only a key the
 * rate table owns is a currency, and everything else lands on the documented
 * USD default with a real symbol and a real rate attached.
 */

/** Every real currency, and a live cross-check that each one has a table entry. */
const REAL: CostCurrency[] = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD'];

/**
 * Keys that exist on Object.prototype (plus '__proto__', which is an accessor
 * there rather than a data property). None of them is a currency; all of them
 * answer true to `'key' in {}`.
 */
const PROTOTYPE_KEYS = [
  'constructor',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__proto__',
  '__defineGetter__',
  '__lookupGetter__',
];

/** Exactly what src/api/insightRoutes.ts does with `?currency=`, so the test
 *  measures the boundary the attacker actually reaches, not a private helper. */
function asRouteWould(raw: unknown): CostCurrency {
  return isCurrency(raw) ? raw : 'USD';
}

test('no prototype-chain key is a currency', () => {
  for (const key of PROTOTYPE_KEYS) {
    assert.equal(isCurrency(key), false, `'${key}' was accepted as a currency`);
  }
});

test('every shipped currency is still accepted', () => {
  for (const code of REAL) {
    assert.equal(isCurrency(code), true, `${code} was rejected`);
  }
  assert.equal(isCurrency('XYZ'), false);
  assert.equal(isCurrency(42), false);
  assert.equal(isCurrency(null), false);
  assert.equal(isCurrency(undefined), false);
  // An object that merely *claims* to be a currency is not one: the guard must
  // test the table, not the value's own idea of what it stringifies to.
  assert.equal(isCurrency({ toString: () => 'USD' }), false);
});

test('a rejected currency falls back to USD with a real symbol and rate', () => {
  for (const key of [...PROTOTYPE_KEYS, 'XYZ', '', ' USD']) {
    const estimate = estimateCost(1000 ** 3, 0, asRouteWould(key));
    assert.equal(estimate.currency, 'USD', `'${key}' escaped the fallback`);
    assert.equal(estimate.symbol, '$');
    assert.equal(estimate.rateFromUsd, 1);
    assert.equal(estimate.approximate, false);
  }
});

test('a prototype key cannot reach the symbol or rate table', () => {
  // Defence in depth: even a caller that skips the guard (a JS caller, or a
  // future route that forgets it) must not be able to pull a function off
  // Object.prototype and have it serialised as this answer's symbol/rate.
  for (const key of PROTOTYPE_KEYS) {
    const estimate = estimateCost(1000 ** 3, 0, key as CostCurrency);
    assert.equal(typeof estimate.symbol, 'string', `'${key}' produced a non-string symbol`);
    assert.ok(estimate.symbol.length > 0, `'${key}' produced an empty symbol`);
    assert.equal(typeof estimate.rateFromUsd, 'number', `'${key}' produced a non-numeric rate`);
    assert.ok(Number.isFinite(estimate.rateFromUsd) && estimate.rateFromUsd > 0,
      `'${key}' produced a rate of ${estimate.rateFromUsd}`);
  }
});

test('the JSON the route serves always carries a symbol and a rate', () => {
  // This is the shape the bug was actually visible in: a function value is
  // silently dropped by JSON.stringify, so the field vanished from the wire
  // rather than arriving obviously wrong.
  for (const key of [...PROTOTYPE_KEYS, ...REAL]) {
    const wire = JSON.parse(JSON.stringify(estimateCost(1000 ** 3, 0, asRouteWould(key))));
    assert.ok(Object.prototype.hasOwnProperty.call(wire, 'symbol'), `'${key}' lost the symbol on the wire`);
    assert.ok(Object.prototype.hasOwnProperty.call(wire, 'rateFromUsd'), `'${key}' lost the rate on the wire`);
    assert.equal(typeof wire.symbol, 'string');
    assert.equal(typeof wire.rateFromUsd, 'number');
  }
});

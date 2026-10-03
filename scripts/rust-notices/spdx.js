'use strict';
/*
 * SPDX licence expressions for scripts/rust-notices.js: parse one, list the
 * licences it names, and decide whether permissive terms alone can meet it.
 */

/**
 * Licences a crate may ship under without a person deciding first: all
 * permissive, none asking more of a binary than its notice. Anything else —
 * copyleft, weak copyleft, a LicenseRef, a licence nobody named — stops the
 * generator and fails the test. Add an id here only in a commit of its own.
 */
const PERMISSIVE = new Set([
  '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'CC0-1.0', 'ISC', 'MIT', 'MIT-0',
  'Unicode-3.0', 'Unicode-DFS-2016', 'Unlicense', 'Zlib',
]);

const OPERATORS = ['AND', 'OR', 'WITH'];
const isOperator = (token, op) => typeof token === 'string' && token.toUpperCase() === op;
const isLicenceToken = (token) => typeof token === 'string' && /^[A-Za-z0-9.+:-]+$/.test(token) && !OPERATORS.some((op) => isOperator(token, op));

/**
 * An SPDX licence expression as a tree: { id, exception? }, { and: [...] } or
 * { or: [...] }. WITH binds tightest, then AND, then OR; the legacy "/" is OR.
 * Throws "licence expression … does not parse" on anything else.
 */
function parseSpdx(expression) {
  const source = String(expression ?? '');
  const tokens = [];
  const re = /\s*(\(|\)|\/|[A-Za-z0-9.+:-]+)\s*/y;
  for (let at = 0; at < source.length; ) {
    re.lastIndex = at;
    const m = re.exec(source);
    if (!m) {
      if (source.slice(at).trim() === '') break;
      throw new Error(`licence expression "${source}" does not parse at "${source.slice(at)}"`);
    }
    tokens.push(m[1]);
    at = re.lastIndex;
  }
  let pos = 0;
  const fail = (why) => {
    throw new Error(`licence expression "${source}" does not parse: ${why}`);
  };
  const atom = () => {
    const token = tokens[pos++];
    if (token === undefined) fail('it ends where a licence was expected');
    if (token === '(') {
      const inner = anyOf();
      if (tokens[pos++] !== ')') fail('a "(" is never closed');
      return inner;
    }
    if (!isLicenceToken(token)) fail(`"${token}" stands where a licence was expected`);
    if (!isOperator(tokens[pos], 'WITH')) return { id: token };
    pos += 1;
    const exception = tokens[pos++];
    if (!isLicenceToken(exception)) fail('WITH names no exception');
    return { id: token, exception };
  };
  const allOf = () => {
    const args = [atom()];
    while (isOperator(tokens[pos], 'AND')) {
      pos += 1;
      args.push(atom());
    }
    return args.length === 1 ? args[0] : { and: args };
  };
  const anyOf = () => {
    const args = [allOf()];
    while (isOperator(tokens[pos], 'OR') || tokens[pos] === '/') {
      pos += 1;
      args.push(allOf());
    }
    return args.length === 1 ? args[0] : { or: args };
  };
  if (tokens.length === 0) fail('it is empty');
  const tree = anyOf();
  if (pos !== tokens.length) fail(`"${tokens[pos]}" follows a complete expression`);
  return tree;
}

/** Every licence and exception id an expression names, once each, in the order it names them. */
function spdxIds(expression) {
  const ids = [];
  const walk = (node) => {
    if (node.and || node.or) {
      for (const arg of node.and || node.or) walk(arg);
      return;
    }
    for (const id of node.exception ? [node.id, node.exception] : [node.id]) if (!ids.includes(id)) ids.push(id);
  };
  walk(parseSpdx(expression));
  return ids;
}

/** Whether the expression can be met with PERMISSIVE licences alone: one branch of an OR, every part of an AND. Unparseable is false. */
function isPermissive(expression) {
  let tree;
  try {
    tree = parseSpdx(expression);
  } catch {
    return false;
  }
  const met = (node) => {
    if (node.or) return node.or.some(met);
    if (node.and) return node.and.every(met);
    return PERMISSIVE.has(node.id); // an exception only ever adds permissions
  };
  return met(tree);
}

module.exports = { PERMISSIVE, parseSpdx, spdxIds, isPermissive };

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnnouncement, buildQuery, decodeName, decodeTxt, encodeName, encodeTxt, parseResponse, SERVICE_TYPE } from '../src/services/fleet/mdns';

/**
 * §D1 discovery — the DNS wire format, round-tripped.
 *
 * Hand-written binary parsing is exactly where subtle bugs live, and this one
 * reads packets off a network socket, so the malformed cases matter as much as
 * the happy path.
 */

test('a name round-trips through its label encoding', () => {
  const buf = encodeName(SERVICE_TYPE);
  assert.equal(decodeName(buf, 0).name, SERVICE_TYPE);
  assert.equal(decodeName(encodeName('Studio Mac._treemap._tcp.local'), 0).name, 'Studio Mac._treemap._tcp.local');
});

test('an over-long label is refused rather than truncated', () => {
  assert.throws(() => encodeName('x'.repeat(64) + '.local'), /label too long/);
});

test('TXT pairs round-trip', () => {
  const pairs = { id: 'abc-123', label: 'Studio Mac', v: '2.6.1' };
  assert.deepEqual(decodeTxt(encodeTxt(pairs)), pairs);
  assert.deepEqual(decodeTxt(encodeTxt({})), {});
});

test('an announcement parses back into the peer it describes', () => {
  const packet = buildAnnouncement({
    instanceName: 'studio-mac', port: 4290, address: '192.168.1.42',
    txt: { id: 'inst-1', label: 'Studio Mac' },
  });
  const peer = parseResponse(packet);
  assert.ok(peer, 'the announcement must be readable');
  assert.equal(peer.instanceName, 'studio-mac');
  assert.equal(peer.port, 4290);
  assert.equal(peer.address, '192.168.1.42');
  assert.equal(peer.txt.label, 'Studio Mac');
});

test('a query is a well-formed single question', () => {
  const q = buildQuery();
  assert.equal(q.readUInt16BE(4), 1, 'one question');
  assert.equal(q.readUInt16BE(6), 0, 'no answers');
  assert.equal(decodeName(q, 12).name, SERVICE_TYPE);
});

test('a malformed packet is dropped, never thrown', () => {
  for (const bad of [
    Buffer.alloc(0),
    Buffer.alloc(5),
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0xff]),
    Buffer.concat([buildAnnouncement({ instanceName: 'x', port: 1, address: '1.2.3.4', txt: {} }).subarray(0, 20)]),
  ]) {
    assert.doesNotThrow(() => parseResponse(bad));
    // Anything unreadable must simply not become a peer.
    const out = parseResponse(bad);
    assert.ok(out === null || (typeof out.instanceName === 'string' && out.port > 0));
  }
});

test('a compression pointer loop cannot hang the listener', () => {
  // A packet whose name points at itself would spin forever without the guard,
  // in a process reading from a network socket.
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0xc00c, 12); // pointer to offset 12 — itself
  assert.throws(() => decodeName(buf, 12), /pointer/);
  assert.equal(parseResponse(buf), null);
});

test('a forward compression pointer is rejected', () => {
  const buf = Buffer.alloc(32);
  buf.writeUInt16BE(0xc018, 12); // points forward, which no real encoder emits
  assert.throws(() => decodeName(buf, 12), /bad compression pointer/);
});

test('a packet advertising some other service is ignored', () => {
  const other = buildAnnouncement({ instanceName: 'printer', port: 631, address: '192.168.1.9', txt: {} });
  // Rewrite EVERY occurrence of the service type — a plain `.replace` with a
  // string swaps only the first, leaving a packet that is still half ours.
  const foreign = Buffer.from(other.toString('binary').replaceAll('treemap', 'airprin'), 'binary');
  const peer = parseResponse(foreign);
  assert.equal(peer, null, 'only our own service type may produce a peer');
});

#!/usr/bin/env node
// Verifies the KISS port-nibble extension (this repo's addition over
// NexDigi's original kiss.js, which hardcoded port 0) round-trips
// correctly for every valid port 0-15, and that random binary payloads
// containing KISS-special bytes (0xC0/0xDB) survive escaping intact.
const assert = require('assert');
const crypto = require('crypto');
const { escapeFrame, unescapeStream } = require('../electron/main/ax25/kiss');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.message}`); fail++; }
}

for (let port = 0; port <= 15; port++) {
  test(`port ${port} round-trips a short ASCII payload`, () => {
    const payload = Buffer.from(`hello on port ${port}`);
    const wire = escapeFrame(payload, port);
    const decoded = unescapeStream(wire);
    assert.strictEqual(decoded.length, 1);
    assert.strictEqual(decoded[0].port, port);
    assert.strictEqual(Buffer.compare(decoded[0].frame, payload), 0);
  });
}

test('random binary payload with 0xC0/0xDB bytes survives escaping on a non-zero port', () => {
  const payload = crypto.randomBytes(300);
  const wire = escapeFrame(payload, 7);
  const decoded = unescapeStream(wire);
  assert.strictEqual(decoded.length, 1);
  assert.strictEqual(decoded[0].port, 7);
  assert.strictEqual(Buffer.compare(decoded[0].frame, payload), 0);
});

test('multiple frames on different ports in one stream are each attributed correctly', () => {
  const a = escapeFrame(Buffer.from('frame A'), 0);
  const b = escapeFrame(Buffer.from('frame B'), 3);
  const c = escapeFrame(Buffer.from('frame C'), 15);
  const stream = Buffer.concat([a, b, c]);
  const decoded = unescapeStream(stream);
  assert.strictEqual(decoded.length, 3);
  assert.deepStrictEqual(decoded.map((d) => d.port), [0, 3, 15]);
  assert.deepStrictEqual(decoded.map((d) => d.frame.toString()), ['frame A', 'frame B', 'frame C']);
});

console.log(`\nTests passed: ${pass}`);
console.log(`Tests failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);

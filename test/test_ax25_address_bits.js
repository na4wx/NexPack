#!/usr/bin/env node
// Real bug found investigating "nothing is digipeating me": the AX.25
// address SSID octet's reserved bits (bits 5-6, spec says "normally set to
// 1 1") were always left 0, and UI frames (every APRS beacon/message) had
// their command/response C-bit left at 0/0 on both dest and src instead of
// the real-world convention (dest=1, src=0) — confirmed against Direwolf's
// own from-scratch UI frame construction in ax25_pad.c. Real digipeaters
// and strict AX.25 stacks can reasonably ignore a frame that doesn't look
// like a real AX.25 frame at this level, even though the APRS payload
// itself was always correctly formatted.
//
// These are direct byte-level checks against buildAx25Frame/formatCallsign
// — parseAx25Frame is used to decode results wherever convenient, but the
// assertions inspect raw bytes for the bits parseAx25Frame doesn't expose
// (the reserved bits) since that's the actual thing being fixed.
const assert = require('assert');
const { buildAx25Frame, parseAx25Frame } = require('../electron/main/ax25/ax25');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

// SSID octet bit helpers (see ax25.js's formatCallsign comment for the layout).
const H_OR_C_BIT = 0x80;
const RESERVED_BITS = 0x60;

test('a UI frame (APRS beacon/message/etc) sets the reserved bits to 1,1 on every address', () => {
  const frame = buildAx25Frame({ dest: 'APZNXP', src: 'N0CALL-9', control: 0x03, pid: 0xf0, payload: Buffer.from('!hello'), path: ['WIDE1-1', 'WIDE2-1'] });
  // dest(0-6), src(7-13), path0(14-20), path1(21-27)
  for (const offset of [6, 13, 20, 27]) {
    assert.strictEqual(frame[offset] & RESERVED_BITS, RESERVED_BITS, `byte at address offset ${offset - 6} should have both reserved bits set`);
  }
});

test('a UI frame defaults to command semantics: dest C-bit=1, src C-bit=0 (matches real APRS traffic, confirmed against Direwolf)', () => {
  const frame = buildAx25Frame({ dest: 'APZNXP', src: 'N0CALL-9', control: 0x03, pid: 0xf0, payload: Buffer.from('!hello') });
  assert.strictEqual(frame[6] & H_OR_C_BIT, H_OR_C_BIT, 'destination C-bit should be 1 for a UI frame');
  assert.strictEqual(frame[13] & H_OR_C_BIT, 0, 'source C-bit should be 0 for a UI frame');
});

test('an explicit commandType still overrides the UI-frame default when given', () => {
  const frame = buildAx25Frame({ dest: 'APZNXP', src: 'N0CALL-9', control: 0x03, pid: 0xf0, payload: Buffer.from('!x'), commandType: 'response' });
  assert.strictEqual(frame[6] & H_OR_C_BIT, 0, 'destination C-bit should be 0 for an explicit response frame');
  assert.strictEqual(frame[13] & H_OR_C_BIT, H_OR_C_BIT, 'source C-bit should be 1 for an explicit response frame');
});

test('connected-mode frames (e.g. SABM) are NOT affected by the UI-frame default — both C-bits stay 0 as before', () => {
  const frame = buildAx25Frame({ dest: 'N0CALL-9', src: 'W1ABC-1', control: 0x3f, pid: null, payload: Buffer.alloc(0) });
  assert.strictEqual(frame[6] & H_OR_C_BIT, 0, 'destination C-bit should stay 0 for SABM (no commandType given, not a UI frame)');
  assert.strictEqual(frame[13] & H_OR_C_BIT, 0, 'source C-bit should stay 0 for SABM');
  // Reserved bits should still be set correctly even for non-UI frames.
  assert.strictEqual(frame[6] & RESERVED_BITS, RESERVED_BITS);
  assert.strictEqual(frame[13] & RESERVED_BITS, RESERVED_BITS);
});

test('digipeater path entries default H-bit (repeated flag) to 0 — we originated the frame, nothing has repeated it yet', () => {
  const frame = buildAx25Frame({ dest: 'APZNXP', src: 'N0CALL-9', control: 0x03, pid: 0xf0, payload: Buffer.from('!x'), path: ['WIDE1-1', 'WIDE2-1'] });
  assert.strictEqual(frame[20] & H_OR_C_BIT, 0, 'WIDE1-1 should not be marked repeated on an originated frame');
  assert.strictEqual(frame[27] & H_OR_C_BIT, 0, 'WIDE2-1 should not be marked repeated on an originated frame');
});

test('the reserved-bit fix does not corrupt SSID extraction — parseAx25Frame still reads the right SSIDs back', () => {
  const frame = buildAx25Frame({ dest: 'APZNXP', src: 'N0CALL-9', control: 0x03, pid: 0xf0, payload: Buffer.from('!x'), path: ['WIDE1-1', 'WIDE2-2'] });
  const parsed = parseAx25Frame(frame);
  assert.strictEqual(parsed.addresses[0].callsign, 'APZNXP');
  assert.strictEqual(parsed.addresses[0].ssid, 0);
  assert.strictEqual(parsed.addresses[1].callsign, 'N0CALL');
  assert.strictEqual(parsed.addresses[1].ssid, 9);
  assert.strictEqual(parsed.addresses[2].callsign, 'WIDE1');
  assert.strictEqual(parsed.addresses[2].ssid, 1);
  assert.strictEqual(parsed.addresses[3].callsign, 'WIDE2');
  assert.strictEqual(parsed.addresses[3].ssid, 2);
});

console.log(`\nTests passed: ${pass}`);
console.log(`Tests failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);

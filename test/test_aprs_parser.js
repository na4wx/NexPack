#!/usr/bin/env node
// Deterministic correctness tests for aprsParser.js, using known real-world
// sample packets — this is the one milestone where live traffic content is
// non-deterministic, so fixed fixtures are the correctness bar (same
// principle as test_kiss_port_nibble.js's byte fixtures).
//
// The Mic-E fixtures are the two worked examples from the official spec
// itself (aprs.org/doc/APRS101.PDF, Chapter 10) — chosen specifically
// because Mic-E's bit-packed destination-address encoding and dual
// legacy/modern SP+28/DC+28 encoding schemes are easy to get subtly wrong,
// and the spec's own worked examples are the most authoritative fixture
// available (the DC+28 decode required cross-deriving a correction from
// the full table since the worked example's prose alone was ambiguous —
// see aprsParser.js's comments).
const assert = require('assert');
const { parsePosition, parseWeather, decodeMicE, parseTnc2Line } = require('../electron/main/aprs/aprsParser');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

function approx(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${msg}: expected ~${expected}, got ${actual}`);
}

test('parsePosition: uncompressed format decodes a real-world sample packet', () => {
  // W1AW-1 style: lat 41 43.24 N, lon 072 17.26 W, symbol '/' 'k' (school bus... arbitrary)
  const pos = parsePosition('!4143.24N/07217.26W>Test comment');
  assert.ok(pos, 'should parse');
  approx(pos.latitude, 41 + 43.24 / 60, 0.0001, 'latitude');
  approx(pos.longitude, -(72 + 17.26 / 60), 0.0001, 'longitude');
  assert.strictEqual(pos.symbol, '>T'); // the 2 chars immediately after longitude
  assert.strictEqual(pos.format, 'uncompressed');
});

test('parsePosition: compressed (Base91) format decodes correctly', () => {
  // Canonical compressed example from APRS101.PDF section 9: /5L!!<*e7>7P[
  // decodes to approximately 49 30.00 N / 072 45.00 W... APRS101's own
  // canonical compressed example is "/5L!!<*e7>7P[" -> lat 49.5, lon -72.75
  const pos = parsePosition('/5L!!<*e7>7P[');
  assert.ok(pos, 'should parse');
  approx(pos.latitude, 49.5, 0.01, 'latitude');
  approx(pos.longitude, -72.75, 0.01, 'longitude');
  assert.strictEqual(pos.format, 'compressed');
});

test('parseWeather: decodes the _ddd/sssgggg wind + txxx format', () => {
  const w = parseWeather('!4903.50N/07201.75W_090/000g000t066r000p000h60b10151');
  assert.ok(w, 'should parse');
  assert.strictEqual(w.windDirection, 90);
  assert.strictEqual(w.windSpeed, 0);
  assert.strictEqual(w.windGust, 0);
  assert.strictEqual(w.temperature, 66);
  assert.strictEqual(w.humidity, 60);
  approx(w.pressure, 1015.1, 0.01, 'pressure');
  approx(w.latitude, 49 + 3.50 / 60, 0.0001, 'weather latitude');
});

test('decodeMicE: destination-address latitude/N-S/message-type matches the spec\'s own worked example', () => {
  // APRS101.PDF Chapter 10 example: dest bytes S,3,2,U,6,T -> 33°25.64' N,
  // longitude offset +0, West, standard message bits 1/0/0 = "M3: Returning"
  const destBytes = Buffer.from('S32U6T', 'ascii');
  // Minimal syntactically-valid 9-byte payload just to satisfy decodeMicE's
  // length/DTI check — only the destination-address fields are asserted here.
  const payload = '`(_fn"Oj/';
  const result = decodeMicE(destBytes, payload);
  assert.ok(result, 'should decode');
  approx(result.latitude, 33 + 25.64 / 60, 0.0001, 'latitude');
  assert.strictEqual(result.messageType, 'M3: Returning');
});

test('decodeMicE: information-field longitude/speed/course matches the spec\'s own worked example exactly', () => {
  // destBytes constructed for longitude offset +100 (byte5 bit=1) and West
  // (byte6 bit=1); other fields arbitrary since only longitude/speed/course
  // are asserted here (matches the spec's stated preconditions for this example).
  const destBytes = Buffer.from('0000PP', 'ascii');
  const payload = '`(_fn"Oj/'; // DTI ` , d=( m=_ h=f SP=n DC=" SE=O symCode=j symTable=/
  const result = decodeMicE(destBytes, payload);
  assert.ok(result, 'should decode');
  approx(result.longitude, -(112 + 7.74 / 60), 0.0001, 'longitude (112° 7.74\' W)');
  assert.strictEqual(result.speed, 20, 'speed should be exactly 20 knots per the spec example');
  assert.strictEqual(result.course, 251, 'course should be exactly 251 degrees per the spec example');
  assert.strictEqual(result.symbol, '/j', 'jeep symbol from the primary table, per the spec example');
});

test('decodeMicE: returns null for non-Mic-E payloads (wrong DTI)', () => {
  const destBytes = Buffer.from('S32U6T', 'ascii');
  assert.strictEqual(decodeMicE(destBytes, '!4143.24N/07217.26W>not mic-e'), null);
});

test('parseTnc2Line: splits a real APRS-IS TNC2 line correctly', () => {
  const parsed = parseTnc2Line('N0CALL-9>APRS,WIDE1-1,WIDE2-1:!4903.50N/07201.75W>Test status');
  assert.ok(parsed);
  assert.strictEqual(parsed.from, 'N0CALL-9');
  assert.strictEqual(parsed.to, 'APRS');
  assert.deepStrictEqual(parsed.path, ['WIDE1-1', 'WIDE2-1']);
  assert.strictEqual(parsed.payload, '!4903.50N/07201.75W>Test status');
});

test('parseTnc2Line: ignores server comment/banner lines', () => {
  assert.strictEqual(parseTnc2Line('# javAPRSSrvr 4.3.4'), null);
  assert.strictEqual(parseTnc2Line(''), null);
});

console.log(`\nTests passed: ${pass}`);
console.log(`Tests failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);

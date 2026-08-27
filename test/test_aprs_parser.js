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
const {
  parsePosition, parseWeather, decodeMicE, parseTnc2Line,
  parseMessage, buildMessagePacket, buildAckPacket, buildPositionPacket,
  parseObject, buildObjectPacket, parseTelemetry, parseTelemetryMetadata
} = require('../electron/main/aprs/aprsParser');

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
  assert.strictEqual(pos.symbol, '/>'); // real table char (the lat/lon separator) + real code char
  assert.strictEqual(pos.format, 'uncompressed');
});

test('parsePosition: timestamped report (DTI @) with a real overlay-character table ID decodes correctly', () => {
  // Captured live from APRS-IS — a real repeater beacon that exposed two
  // real bugs before being fixed: the '@' DTI's mandatory 7-byte timestamp
  // wasn't skipped, AND the overlay-character table ID ('I', not '/'/'\')
  // wasn't accepted — both caused this exact packet to fall through to the
  // compressed-format regex and decode to a wildly wrong position.
  const pos = parsePosition('@271415z3728.40NI08541.17W# 12.5V, 71.4F, NEW REPEATER 440.6125 + CC1');
  assert.ok(pos, 'should parse as uncompressed, not fall through to compressed');
  assert.strictEqual(pos.format, 'uncompressed');
  approx(pos.latitude, 37 + 28.40 / 60, 0.0001, 'latitude');
  approx(pos.longitude, -(85 + 41.17 / 60), 0.0001, 'longitude');
  assert.strictEqual(pos.symbol, 'I#');
});

test('parsePosition: timestamped weather report (DTI @, table char /) decodes correctly, not as compressed', () => {
  // Also captured live — a CWOP weather station. Same missing-timestamp
  // bug as above, but with a plain '/' table char (isolates the timestamp
  // fix from the overlay-character fix).
  const pos = parsePosition('@271450z3424.82N/08615.90W_.../000g000t076r000p044P000b10146h82.weewx-5.3.1-Vantage');
  assert.ok(pos, 'should parse as uncompressed');
  assert.strictEqual(pos.format, 'uncompressed');
  approx(pos.latitude, 34 + 24.82 / 60, 0.0001, 'latitude');
  approx(pos.longitude, -(86 + 15.90 / 60), 0.0001, 'longitude');
});

test('parsePosition: compressed (Base91) format decodes correctly', () => {
  // "/5L!!<*e7>7P[" is APRS101's own canonical compressed-position example
  // (49°30'00"N/72°45'00"W) — but as it appears embedded in an Object
  // report (line 3021 of the spec), where the object's own ';' already
  // serves as the DTI, so this fragment has NO separate leading DTI byte.
  // A genuine standalone compressed position report needs both a real DTI
  // and a real symbol-table-ID byte before the lat data - prepending '!'
  // here to make this a correct standalone fixture (parseObject(), tested
  // separately below, does its own equivalent prepending internally).
  const pos = parsePosition('!/5L!!<*e7>7P[');
  assert.ok(pos, 'should parse');
  approx(pos.latitude, 49.5, 0.01, 'latitude');
  approx(pos.longitude, -72.75, 0.01, 'longitude');
  assert.strictEqual(pos.format, 'compressed');
  assert.strictEqual(pos.symbol, '/>', 'table id "/" + code ">", both real bytes this time');
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

// ---- Messages (APRS101.PDF Chapter 14 worked examples) ----

test('parseMessage: decodes the spec\'s own unacked-message example exactly', () => {
  const parsed = parseMessage(':WU2Z     :Testing');
  assert.ok(parsed);
  assert.strictEqual(parsed.addressee, 'WU2Z');
  assert.strictEqual(parsed.text, 'Testing');
  assert.strictEqual(parsed.msgId, null);
  assert.strictEqual(parsed.isAck, false);
});

test('parseMessage: decodes the spec\'s own acked-message example exactly', () => {
  const parsed = parseMessage(':WU2Z     :Testing{003');
  assert.ok(parsed);
  assert.strictEqual(parsed.addressee, 'WU2Z');
  assert.strictEqual(parsed.text, 'Testing');
  assert.strictEqual(parsed.msgId, '003');
});

test('parseMessage: decodes the spec\'s own ack example exactly', () => {
  const parsed = parseMessage(':KB2ICI-14:ack003');
  assert.ok(parsed);
  assert.strictEqual(parsed.addressee, 'KB2ICI-14');
  assert.strictEqual(parsed.msgId, '003');
  assert.strictEqual(parsed.isAck, true);
});

test('parseMessage: decodes the spec\'s own rej example exactly', () => {
  const parsed = parseMessage(':KB2ICI-14:rej003');
  assert.ok(parsed);
  assert.strictEqual(parsed.isRej, true);
  assert.strictEqual(parsed.msgId, '003');
});

test('buildMessagePacket/buildAckPacket: round-trip through parseMessage with correct 9-char padding', () => {
  const packet = buildMessagePacket({ addressee: 'W1ABC', text: 'Hello there', msgId: 'A1' });
  assert.strictEqual(packet, ':W1ABC    :Hello there{A1'); // "W1ABC" + 4 spaces = 9 chars
  const parsed = parseMessage(packet);
  assert.strictEqual(parsed.addressee, 'W1ABC');
  assert.strictEqual(parsed.text, 'Hello there');
  assert.strictEqual(parsed.msgId, 'A1');

  const ackPacket = buildAckPacket({ addressee: 'W1ABC', msgId: 'A1' });
  const parsedAck = parseMessage(ackPacket);
  assert.strictEqual(parsedAck.isAck, true);
  assert.strictEqual(parsedAck.msgId, 'A1');
  assert.strictEqual(parsedAck.addressee, 'W1ABC');
});

test('buildMessagePacket: works with a full 9-char addressee (no padding needed, like the spec\'s KB2ICI-14 example)', () => {
  const packet = buildMessagePacket({ addressee: 'KB2ICI-14', text: 'hi', msgId: null });
  assert.strictEqual(packet, ':KB2ICI-14:hi');
});

// ---- Position build/parse round-trip ----

test('buildPositionPacket: round-trips through parsePosition', () => {
  const packet = buildPositionPacket({ lat: 41 + 43.24 / 60, lon: -(72 + 17.26 / 60), symbol: '/>', comment: 'test' });
  const parsed = parsePosition(packet);
  assert.ok(parsed);
  approx(parsed.latitude, 41 + 43.24 / 60, 0.001, 'round-tripped latitude');
  approx(parsed.longitude, -(72 + 17.26 / 60), 0.001, 'round-tripped longitude');
  assert.strictEqual(parsed.symbol, '/>');
});

// ---- Objects (APRS101.PDF Chapter 11 worked example) ----

test('parseObject: decodes the spec\'s own worked example exactly', () => {
  const parsed = parseObject(';LEADER   *092345z4903.50N/07201.75W>088/036');
  assert.ok(parsed);
  assert.strictEqual(parsed.name, 'LEADER');
  assert.strictEqual(parsed.killed, false);
  approx(parsed.latitude, 49 + 3.5 / 60, 0.0001, 'latitude');
  approx(parsed.longitude, -(72 + 1.75 / 60), 0.0001, 'longitude');
});

test('parseObject: decodes the killed variant from the spec\'s own example', () => {
  const parsed = parseObject(';LEADER   _092345z4903.50N/07201.75W>088/036');
  assert.ok(parsed);
  assert.strictEqual(parsed.killed, true);
});

test('buildObjectPacket: round-trips through parseObject', () => {
  const packet = buildObjectPacket({ name: 'NET1', lat: 49.5, lon: -72.75, symbol: '/>', comment: 'net control' });
  const parsed = parseObject(packet);
  assert.ok(parsed);
  assert.strictEqual(parsed.name, 'NET1');
  assert.strictEqual(parsed.killed, false);
  approx(parsed.latitude, 49.5, 0.01, 'latitude');
  approx(parsed.longitude, -72.75, 0.01, 'longitude');
});

// ---- Telemetry (APRS101.PDF Chapter 13 worked examples) ----

test('parseTelemetry: decodes the spec\'s own numeric-sequence example exactly', () => {
  const t = parseTelemetry('T#005,199,000,255,073,123,01101001');
  assert.ok(t);
  assert.strictEqual(t.seq, '005');
  assert.deepStrictEqual(t.analog, [199, 0, 255, 73, 123]);
  assert.deepStrictEqual(t.digital, [0, 1, 1, 0, 1, 0, 0, 1]);
});

test('parseTelemetry: decodes the spec\'s own MIC-sequence example exactly', () => {
  const t = parseTelemetry('T#MIC199,000,255,073,123,01101001');
  assert.ok(t);
  assert.strictEqual(t.seq, 'MIC');
  assert.deepStrictEqual(t.analog, [199, 0, 255, 73, 123]);
});

test('parseTelemetryMetadata: decodes the spec\'s own N0QBF-11 PARM example exactly', () => {
  const meta = parseTelemetryMetadata('PARM.Battery,Btemp,ATemp,Pres,Alt,Camra,Chut,Sun,10m,ATV');
  assert.ok(meta);
  assert.strictEqual(meta.kind, 'PARM');
  assert.deepStrictEqual(meta.values.slice(0, 5), ['Battery', 'Btemp', 'ATemp', 'Pres', 'Alt']);
});

test('parseTelemetryMetadata: decodes the spec\'s own N0QBF-11 UNIT example exactly', () => {
  const meta = parseTelemetryMetadata('UNIT.v/100,deg.F,deg.F,Mbar,Kft,Click,OPEN,on,on,hi');
  assert.ok(meta);
  assert.strictEqual(meta.kind, 'UNIT');
  assert.strictEqual(meta.values[0], 'v/100');
});

test('parseTelemetryMetadata: parses EQNS into grouped [a,b,c] coefficient triples', () => {
  const meta = parseTelemetryMetadata('EQNS.0,1,0,0,2,0,0,1,10');
  assert.ok(meta);
  assert.strictEqual(meta.kind, 'EQNS');
  assert.deepStrictEqual(meta.values, [[0, 1, 0], [0, 2, 0], [0, 1, 10]]);
});

test('parseTelemetryMetadata: returns null for a normal (non-telemetry) message', () => {
  assert.strictEqual(parseTelemetryMetadata('Hello there'), null);
});

console.log(`\nTests passed: ${pass}`);
console.log(`Tests failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);

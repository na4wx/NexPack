#!/usr/bin/env node
// Real end-to-end test of the RF ingestion path: a real AX.25 UI frame
// carrying a real APRS payload, sent between two real TncManager instances
// over a real TCP loopback bridge (same proven pattern as
// test_terminal_kisstcp.js), verifying AprsManager picks it up off the
// real 'monitor' event stream — not a mocked/synthetic station update.
const assert = require('assert');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TncManager = require('../electron/main/tnc/TncManager');
const AprsManager = require('../electron/main/aprs/AprsManager');
const { buildAx25Frame } = require('../electron/main/ax25/ax25');
const { escapeFrame } = require('../electron/main/ax25/kiss');
const { buildMessagePacket } = require('../electron/main/aprs/aprsParser');

function startBridge(port) {
  return new Promise((resolve) => {
    const clients = [];
    const server = net.createServer((socket) => {
      clients.push(socket);
      socket.on('data', (data) => { for (const other of clients) if (other !== socket && !other.destroyed) other.write(data); });
      socket.on('error', () => {});
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Simulates a real digipeater repeat: builds a real AX.25 frame with a
// path, then manually sets the AX.25 H-bit ("has been repeated") on the
// first path address's byte, the same way an actual digipeater marks a
// hop it has retransmitted. There's no in-process digipeater to produce
// this legitimately, so this constructs the on-air bytes directly and
// injects them straight onto the bridge (bypassing TncManager's own
// sendUnproto, which always originates with H-bit 0).
function sendDigipeatedFrame(bridgeSocket, { dest, src, path, payload }) {
  const frame = buildAx25Frame({ dest, src, control: 0x03, pid: 0xf0, payload: Buffer.from(payload, 'utf8'), path });
  // Address layout: dest(0-6), src(7-13), path[0](14-20), path[1](21-27)...
  // — the H-bit lives in byte 6 of each 7-byte address field.
  const firstPathHBitOffset = 14 + 6;
  frame[firstPathHBitOffset] |= 0x80;
  bridgeSocket.write(escapeFrame(frame, 0));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const bridgePort = 19900 + Math.floor(Math.random() * 1000);
  const bridge = await startBridge(bridgePort);

  const mgrA = new TncManager({});
  const mgrB = new TncManager({});
  const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const tncB = mgrB.createTnc({ name: 'B', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: 'N0CALL-9', portNumber: 0 });
  mgrB.addRadio(tncB.id, { callsign: 'W1ABC-1', portNumber: 0 });

  mgrA.connectTnc(tncA.id);
  mgrB.connectTnc(tncB.id);
  await wait(200);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-aprs-rf-test-'));
  const aprs = new AprsManager({ userDataDir: dir, tncManager: mgrB });
  const updates = [];
  aprs.on('aprs-station', (record) => updates.push(record));

  await test('a real APRS UI frame heard over RF produces a correct station record', async () => {
    mgrA.sendUnproto(tncA.id, radioA.id, 'APRS', '!4903.50N/07201.75W>Test station via RF');
    await wait(300);
    const record = updates.find((u) => u.callsign === 'N0CALL-9');
    assert.ok(record, 'AprsManager should have produced a station record for N0CALL-9');
    assert.ok(Math.abs(record.lastPosition.lat - (49 + 3.5 / 60)) < 0.0001, 'latitude should decode correctly');
    assert.ok(Math.abs(record.lastPosition.lon - -(72 + 1.75 / 60)) < 0.0001, 'longitude should decode correctly');
    assert.strictEqual(record.source, 'rf');
    assert.strictEqual(record.comment, ''); // status only set for Mic-E; not asserting comment parsing here
    // No path at all -> definitely heard direct, not through a digipeater.
    assert.strictEqual(record.lastHeardDirect, true);
    assert.strictEqual(record.everHeardDirect, true);
  });

  await test('getStations() reflects the update', () => {
    const stations = aprs.getStations();
    assert.ok(stations.find((s) => s.callsign === 'N0CALL-9'));
  });

  await test('a frame repeated by a digipeater (real H-bit set) is recorded as heard via digipeater, not direct', async () => {
    // Direct socket onto the bridge, not through mgrA/TncManager, so the
    // H-bit can be set exactly like a real digipeater would.
    const raw = net.createConnection({ host: '127.0.0.1', port: bridgePort });
    await new Promise((resolve) => raw.on('connect', resolve));
    sendDigipeatedFrame(raw, { dest: 'APZNXP', src: 'KC5XYZ-9', path: ['WIDE1-1', 'WIDE2-1'], payload: '!4900.00N/07200.00W>Heard via digi' });
    await wait(300);
    raw.end();

    const record = aprs.getStations().find((s) => s.callsign === 'KC5XYZ-9');
    assert.ok(record, 'AprsManager should have produced a station record for KC5XYZ-9');
    assert.strictEqual(record.lastHeardDirect, false, 'a marked (repeated) path hop means this was NOT heard direct');
    assert.strictEqual(record.everHeardDirect, false);
  });

  await test('everHeardDirect is sticky: a station heard direct once stays flagged even if later heard only via a digipeater', async () => {
    // KC5XYZ-9 above was only ever heard via digi. This one (N0CALL-9) was
    // heard direct in the very first test above — confirm a subsequent
    // digipeated packet from the SAME station doesn't clear that history.
    const raw = net.createConnection({ host: '127.0.0.1', port: bridgePort });
    await new Promise((resolve) => raw.on('connect', resolve));
    sendDigipeatedFrame(raw, { dest: 'APZNXP', src: 'N0CALL-9', path: ['WIDE1-1', 'WIDE2-1'], payload: '!4903.50N/07201.75W>Now via digi' });
    await wait(300);
    raw.end();

    const record = aprs.getStations().find((s) => s.callsign === 'N0CALL-9');
    assert.strictEqual(record.lastHeardDirect, false, 'this specific packet was digipeated');
    assert.strictEqual(record.everHeardDirect, true, 'but it was heard direct at least once before, which should stick');
  });

  await test('hearing our own message get digipeated back to us does NOT show up as a new message from ourselves', async () => {
    // Reported live: sending an APRS message and then hearing it come back
    // via a digipeater made it appear as a brand new INCOMING message from
    // yourself. Configure this station's own callsign, then inject a real
    // digipeated (H-bit set) frame whose SOURCE is that same callsign —
    // exactly what your own receiver actually hears when a digipeater
    // repeats something you just transmitted.
    aprs.saveMyStation({ mycall: 'W1ABC-1', symbol: '/>', comment: '', homePosition: null, beacon: { enabled: false, intervalMinutes: 30, path: '', tncId: null, radioId: null } });
    const before = aprs.getMessages().length;
    const messagePayload = buildMessagePacket({ addressee: 'N0CALL-9', text: 'hello from myself, digipeated', msgId: '1' });

    const raw = net.createConnection({ host: '127.0.0.1', port: bridgePort });
    await new Promise((resolve) => raw.on('connect', resolve));
    sendDigipeatedFrame(raw, { dest: 'APZNXP', src: 'W1ABC-1', path: ['WIDE1-1', 'WIDE2-1'], payload: messagePayload });
    await wait(300);
    raw.end();

    const after = aprs.getMessages();
    assert.strictEqual(after.length, before, 'no new message record should have been created from hearing our own digipeated transmission');
    assert.ok(!after.some((m) => m.callsign === 'W1ABC-1' && m.direction === 'in'), 'there should be no incoming message that appears to be from ourselves');
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  aprs.shutdown();
  mgrA.shutdown();
  mgrB.shutdown();
  bridge.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

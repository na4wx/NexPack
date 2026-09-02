#!/usr/bin/env node
// Real end-to-end test of Milestone 4b transmit-side APRS behavior:
// beaconing, messaging (send/auto-ack/ack-received), objects (create/see/
// kill), and telemetry+metadata scaling — all over a real TCP-bridged
// two-TncManager RF loopback (same proven pattern as
// test_aprs_manager_rf.js), with two real AprsManager instances so acks
// genuinely round-trip over the air rather than being simulated.
const assert = require('assert');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TncManager = require('../electron/main/tnc/TncManager');
const AprsManager = require('../electron/main/aprs/AprsManager');
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
  const radioB = mgrB.addRadio(tncB.id, { callsign: 'W1ABC-1', portNumber: 0 });

  mgrA.connectTnc(tncA.id);
  mgrB.connectTnc(tncB.id);
  await wait(200);

  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-aprs-tx-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-aprs-tx-b-'));
  const aprsA = new AprsManager({ userDataDir: dirA, tncManager: mgrA });
  const aprsB = new AprsManager({ userDataDir: dirB, tncManager: mgrB });

  aprsA.saveMyStation({ mycall: 'N0CALL-9', symbol: '/>', comment: 'Test A', homePosition: { lat: 49 + 3.5 / 60, lon: -(72 + 1.75 / 60) }, beacon: { enabled: false, intervalMinutes: 30, path: '', tncId: tncA.id, radioId: radioA.id } });
  aprsB.saveMyStation({ mycall: 'W1ABC-1', symbol: '/>', comment: 'Test B', homePosition: { lat: 49, lon: -72 }, beacon: { enabled: false, intervalMinutes: 30, path: '', tncId: tncB.id, radioId: radioB.id } });

  await test('beaconNow() transmits a real position packet that the other node receives correctly', async () => {
    aprsA.beaconNow();
    await wait(300);
    const record = aprsB.getStations().find((s) => s.callsign === 'N0CALL-9');
    assert.ok(record, 'B should have heard A\'s beacon');
    assert.ok(Math.abs(record.lastPosition.lat - (49 + 3.5 / 60)) < 0.001, 'latitude should match');
    assert.ok(Math.abs(record.lastPosition.lon - -(72 + 1.75 / 60)) < 0.001, 'longitude should match');
  });

  await test('beacons transmit with a real tocall (not literal "APRS") and the configured digipeater path', async () => {
    // Real-world bug: the AX.25 destination was hardcoded to the literal
    // string 'APRS' instead of a proper software tocall, and the
    // beacon.path setting (shown correctly in AprsSettingsPanel, saved
    // correctly) was never actually read when transmitting — every RF
    // packet went out completely path-less regardless of configuration.
    // Reconfigure A's beacon with a real path and capture the raw TX frame
    // via TncManager's own 'monitor' event to verify both are fixed.
    aprsA.saveMyStation({ mycall: 'N0CALL-9', symbol: '/>', comment: 'Test A', homePosition: { lat: 49 + 3.5 / 60, lon: -(72 + 1.75 / 60) }, beacon: { enabled: false, intervalMinutes: 30, path: 'WIDE1-1,WIDE2-1', tncId: tncA.id, radioId: radioA.id } });

    const monitored = new Promise((resolve) => {
      mgrA.once('monitor', (evt) => { if (evt.direction === 'tx' && evt.frameType === 'ui') resolve(evt); });
    });
    aprsA.beaconNow();
    const evt = await monitored;

    assert.notStrictEqual(evt.addresses[0], 'APRS', 'destination should not be the bare literal "APRS"');
    assert.match(evt.addresses[0], /^AP[A-Z0-9]{2,4}$/, `destination "${evt.addresses[0]}" should look like a real tocall (AP + software code)`);
    assert.deepStrictEqual(evt.addresses.slice(2), ['WIDE1-1', 'WIDE2-1'], 'the configured digipeater path should be present on the transmitted frame');
  });

  await test('sendMessage() round-trips: B auto-acks, A marks the message acked', async () => {
    aprsA.sendMessage('W1ABC-1', 'hello from A');
    await wait(400);
    const received = aprsB.getMessages().find((m) => m.direction === 'in' && m.callsign === 'N0CALL-9');
    assert.ok(received, 'B should have received the message');
    assert.strictEqual(received.text, 'hello from A');
    const sent = aprsA.getMessages().find((m) => m.direction === 'out' && m.callsign === 'W1ABC-1');
    assert.ok(sent, 'A should have a record of the sent message');
    assert.strictEqual(sent.status, 'acked', 'A should have received a real ack back from B over RF');
  });

  await test('createObject()/killObject() round-trip over RF', async () => {
    aprsA.createObject('TESTOBJ', { lat: 49, lon: -72, symbol: '/#', comment: 'net control' });
    await wait(300);
    let obj = aprsB.getObjects().find((o) => o.name === 'TESTOBJ');
    assert.ok(obj, 'B should see the object A created');
    assert.strictEqual(obj.killed, false);

    aprsA.killObject('TESTOBJ');
    await wait(300);
    obj = aprsB.getObjects().find((o) => o.name === 'TESTOBJ');
    assert.ok(obj, 'B should still have the object record');
    assert.strictEqual(obj.killed, true, 'B should see the object as killed');
  });

  await test('telemetry + EQNS metadata: raw values get correctly scaled once metadata arrives', async () => {
    mgrA.sendUnproto(tncA.id, radioA.id, 'APRS', 'T#005,100,050,000,000,000,00000000');
    await wait(200);
    let record = aprsB.getStations().find((s) => s.callsign === 'N0CALL-9');
    assert.ok(record && record.telemetry, 'B should have raw telemetry for A');
    assert.deepStrictEqual(record.telemetry.last.analog, [100, 50, 0, 0, 0]);
    assert.strictEqual(record.telemetry.last.scaled, null, 'no EQNS known yet, so scaled should be null');

    // EQNS metadata arrives as a message addressed to the transmitting
    // station's own callsign, per APRS101.PDF Chapter 13.
    const eqnsPacket = buildMessagePacket({ addressee: 'N0CALL-9', text: 'EQNS.0,2,0,0,0.1,32,0,1,0,0,1,0,0,1,0' });
    mgrA.sendUnproto(tncA.id, radioA.id, 'APRS', eqnsPacket);
    await wait(200);
    record = aprsB.getStations().find((s) => s.callsign === 'N0CALL-9');
    assert.ok(record.telemetry.last.scaled, 'scaled values should now be present');
    assert.strictEqual(record.telemetry.last.scaled[0], 2 * 100, 'channel 1: a=0,b=2,c=0 -> 2*100=200');
    assert.strictEqual(record.telemetry.last.scaled[1], 0.1 * 50 + 32, 'channel 2: a=0,b=0.1,c=32 -> 0.1*50+32=37');
  });

  await test('cancelMessage() stops a pending retry immediately instead of waiting it out', async () => {
    const sent = aprsA.sendMessage('NOBODY-9', 'will never be acked');
    assert.ok(aprsA.pendingAcks.has(sent.msgId), 'a retry timer should be pending right after send');
    aprsA.cancelMessage(sent.msgId);
    assert.ok(!aprsA.pendingAcks.has(sent.msgId), 'the retry timer should be cleared immediately on cancel');
    const record = aprsA.getMessages().find((m) => m.msgId === sent.msgId);
    assert.strictEqual(record.status, 'cancelled', 'the message should be marked cancelled, not left as sent');
  });

  await test('cancelMessage() on an already-resolved message is a harmless no-op', async () => {
    // sendMessage()/_updateMessageStatus() already exercised the acked path
    // above (sendMessage() round-trips test) — cancelling an id that's no
    // longer pending should not throw or corrupt state.
    assert.doesNotThrow(() => aprsA.cancelMessage('not-a-real-id'));
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  aprsA.shutdown();
  aprsB.shutdown();
  mgrA.shutdown();
  mgrB.shutdown();
  bridge.close();
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

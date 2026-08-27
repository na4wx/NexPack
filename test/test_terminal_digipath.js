#!/usr/bin/env node
// Real end-to-end test of digipeater path support: connects with a
// multi-hop path over a real TCP-bridged two-TncManager loopback (same
// pattern as test_terminal_kisstcp.js), then decodes the ACTUAL bytes
// transmitted (via parseAx25Frame on the monitor event's raw hex) to prove
// the frame is spec-shaped — not just that the session still connects.
const assert = require('assert');
const net = require('net');
const TncManager = require('../electron/main/tnc/TncManager');
const { parseAx25Frame } = require('../electron/main/ax25/ax25');

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
  const bridgePort = 19700 + Math.floor(Math.random() * 1000);
  const bridge = await startBridge(bridgePort);

  const mgrA = new TncManager({});
  const mgrB = new TncManager({});
  const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const tncB = mgrB.createTnc({ name: 'B', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: 'N0CALL-9', portNumber: 0 });
  mgrB.addRadio(tncB.id, { callsign: 'W1ABC-10', portNumber: 0 });

  const monitorA = [];
  mgrA.on('monitor', (e) => monitorA.push(e));

  mgrA.connectTnc(tncA.id);
  mgrB.connectTnc(tncB.id);
  await wait(200);

  let sessionAId;
  const sessionStatesA = [];
  mgrA.on('session-state', (s) => sessionStatesA.push(s));

  await test('connect with a digipeater path still establishes a session', async () => {
    const snap = mgrA.startSession(tncA.id, radioA.id, 'W1ABC-10', ['WIDE1-1', 'WIDE2-1']);
    sessionAId = snap.id;
    assert.deepStrictEqual(snap.path, ['WIDE1-1', 'WIDE2-1']);
    await wait(200);
    const connected = sessionStatesA.find((s) => s.id === sessionAId && s.state === 'connected');
    assert.ok(connected, 'session should still reach connected state via a digipeater path');
  });

  await test('the actual transmitted SABM frame carries a correctly-shaped 4-address path', () => {
    const sabmTx = monitorA.find((e) => e.direction === 'tx' && e.frameType === 'sabm');
    assert.ok(sabmTx, 'should have captured the outgoing SABM frame');
    const parsed = parseAx25Frame(Buffer.from(sabmTx.raw, 'hex'));
    assert.strictEqual(parsed.addresses.length, 4, 'dest, src, WIDE1-1, WIDE2-1');
    assert.strictEqual(parsed.addresses[0].callsign, 'W1ABC');
    assert.strictEqual(parsed.addresses[1].callsign, 'N0CALL');
    assert.strictEqual(parsed.addresses[2].callsign, 'WIDE1');
    assert.strictEqual(parsed.addresses[2].ssid, 1);
    assert.strictEqual(parsed.addresses[3].callsign, 'WIDE2');
    assert.strictEqual(parsed.addresses[3].ssid, 1);
    assert.strictEqual(parsed.addresses[2].marked, false, 'digi H-bit should be 0 on an originated frame');
    assert.strictEqual(parsed.addresses[3].marked, false);
  });

  await test('subsequent I-frames on the same session reuse the identical path', async () => {
    mgrA.sendSessionText(sessionAId, 'hi via digis');
    await wait(150);
    const iframeTx = monitorA.filter((e) => e.direction === 'tx' && e.frameType === 'iframe').pop();
    assert.ok(iframeTx, 'should have captured the outgoing I-frame');
    const parsed = parseAx25Frame(Buffer.from(iframeTx.raw, 'hex'));
    assert.strictEqual(parsed.addresses.length, 4);
    assert.strictEqual(parsed.addresses[2].callsign, 'WIDE1');
    assert.strictEqual(parsed.addresses[3].callsign, 'WIDE2');
  });

  await test('DISC also reuses the same path', async () => {
    mgrA.endSession(sessionAId);
    await wait(150);
    const discTx = monitorA.filter((e) => e.direction === 'tx' && e.frameType === 'disc').pop();
    assert.ok(discTx, 'should have captured the outgoing DISC frame');
    const parsed = parseAx25Frame(Buffer.from(discTx.raw, 'hex'));
    assert.strictEqual(parsed.addresses.length, 4);
  });

  await test('a direct connect (no path) still produces a plain 2-address frame', async () => {
    const snap2 = mgrA.startSession(tncA.id, radioA.id, 'W1ABC-10');
    assert.deepStrictEqual(snap2.path, []);
    await wait(150);
    const sabmTx = monitorA.filter((e) => e.direction === 'tx' && e.frameType === 'sabm').pop();
    const parsed = parseAx25Frame(Buffer.from(sabmTx.raw, 'hex'));
    assert.strictEqual(parsed.addresses.length, 2);
    mgrA.endSession(snap2.id);
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgrA.shutdown();
  mgrB.shutdown();
  bridge.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

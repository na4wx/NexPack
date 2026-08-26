#!/usr/bin/env node
// End-to-end test of the real TncManager + KissTcpAdapter stack (not a
// bypass): two TncManager instances, each with a real 'kiss-tcp' TNC
// connecting to a virtual TNC bridge (a real net.Server relaying bytes
// between exactly two clients) over an actual TCP socket, the same pattern
// proven in the parent NexDigi repo's test_rftransport_kisstcp_unit.js.
const assert = require('assert');
const net = require('net');
const TncManager = require('../electron/main/tnc/TncManager');

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
  const bridgePort = 19500 + Math.floor(Math.random() * 1000);
  const bridge = await startBridge(bridgePort);

  const mgrA = new TncManager({});
  const mgrB = new TncManager({});
  const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const tncB = mgrB.createTnc({ name: 'B', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: 'N0CALL-10', name: 'Radio A', portNumber: 0 });
  const radioB = mgrB.addRadio(tncB.id, { callsign: 'W1ABC-10', name: 'Radio B', portNumber: 0 });

  const monitorA = [], monitorB = [];
  mgrA.on('monitor', (e) => monitorA.push(e));
  mgrB.on('monitor', (e) => monitorB.push(e));

  mgrA.connectTnc(tncA.id);
  mgrB.connectTnc(tncB.id);
  await wait(200);

  await test('unproto (UI) frame is sent and received over the real KISS-TCP stack', async () => {
    mgrA.sendUnproto(tncA.id, radioA.id, 'W1ABC-10', 'CQ CQ CQ from N0CALL-10');
    await wait(150);
    const heard = monitorB.find((e) => e.frameType === 'ui' && e.text === 'CQ CQ CQ from N0CALL-10');
    assert.ok(heard, 'Node B should have heard the UI frame');
  });

  let sessionAId;
  const sessionStatesA = [];
  mgrA.on('session-state', (s) => sessionStatesA.push(s));

  await test('connected-mode session establishes via real SABM/UA handshake', async () => {
    const snap = mgrA.startSession(tncA.id, radioA.id, 'W1ABC-10');
    sessionAId = snap.id;
    await wait(200);
    const connected = sessionStatesA.find((s) => s.id === sessionAId && s.state === 'connected');
    assert.ok(connected, 'session should reach connected state after UA is received');
  });

  const sessionDataB = [];
  mgrB.on('session-data', (d) => sessionDataB.push(d));

  await test('typed text is delivered as an I-frame and received on the other end', async () => {
    mgrA.sendSessionText(sessionAId, 'hello from the terminal test');
    await wait(200);
    const received = sessionDataB.find((d) => d.text === 'hello from the terminal test');
    assert.ok(received, 'Node B should have received the I-frame payload as session data');
  });

  await test('DISC tears the session down on both ends', async () => {
    mgrA.endSession(sessionAId);
    await wait(200);
    const b = mgrB;
    const bSession = Array.from(b.sessions.values()).find((s) => s.remoteCall === 'N0CALL-10');
    assert.ok(!bSession, 'Node B should have removed its session after receiving DISC');
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgrA.shutdown();
  mgrB.shutdown();
  bridge.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

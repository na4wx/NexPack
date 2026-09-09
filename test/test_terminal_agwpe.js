#!/usr/bin/env node
// End-to-end test of the real TncManager + AgwpeAdapter stack.
//
// UI (unproto) traffic is tested against a minimal fake AGWPE server that
// speaks just enough of the protocol (accepts 'X' login, answers 'G'
// port-info queries, and relays 'K' raw-frame sends to every other
// connected client, like a shared radio bus) — 'K' really is the correct,
// spec-recommended command for this kind of unconnected traffic.
//
// Connected-mode sessions (SABM/I/RR) are NOT tested against that fake
// server, because 'K' is the WRONG command for those (see AgwpeAdapter.js's
// sendFrame() and TncManager.js's startSession() for why: a real external
// AGWPE server's connected-mode dispatcher is never told a session exists
// unless the client uses 'C'/'D'/'d', so hand-rolling a fake server that
// only relays raw 'K' frames would silently validate the exact bug this
// app used to have — confirmed live against a real AGWPE server (UZ7HO
// Soundmodem): the transmitter never even keyed). Instead, this app's own
// already-tested AgwpeBridgeServer stands in as a REAL, spec-correct AGWPE
// server (the same one pat is driven through for Winlink RF), fronting a
// real TncManager + KissTcpAdapter loopback — so the adapter under test
// here is talking to a genuine 'C'/'D'/'d' implementation, not a mock.
const assert = require('assert');
const net = require('net');
const { HEADER_LEN, buildAgwFrame } = require('../electron/main/adapters/AgwpeAdapter');
const TncManager = require('../electron/main/tnc/TncManager');
const AgwpeBridgeServer = require('../electron/main/winlink/AgwpeBridgeServer');

function startFakeAgwServer(port) {
  return new Promise((resolve) => {
    const clients = [];
    const server = net.createServer((socket) => {
      clients.push(socket);
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= HEADER_LEN) {
          const dataLen = buf.readUInt32LE(28);
          if (buf.length < HEADER_LEN + dataLen) break;
          const header = buf.slice(0, HEADER_LEN);
          const data = buf.slice(HEADER_LEN, HEADER_LEN + dataLen);
          buf = buf.slice(HEADER_LEN + dataLen);
          const dataKind = header.toString('ascii', 4, 5);
          const port_ = header.readUInt8(0);
          if (dataKind === 'G') {
            socket.write(buildAgwFrame({ dataKind: 'G', data: '1;Port1 Fake Radio Port;\0' }));
          } else if (dataKind === 'K') {
            for (const other of clients) if (other !== socket && !other.destroyed) {
              other.write(buildAgwFrame({ port: port_, dataKind: 'K', data }));
            }
          }
          // 'X' (login) gets no reply in this fake server — real servers
          // may or may not ack it either, so AgwpeAdapter doesn't require one.
        }
      });
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
  const agwPort = 19700 + Math.floor(Math.random() * 1000);
  const server = await startFakeAgwServer(agwPort);

  const mgrA = new TncManager({});
  const mgrB = new TncManager({});
  const tncA = mgrA.createTnc({ name: 'A', type: 'agwpe', connection: { host: '127.0.0.1', port: agwPort } });
  const tncB = mgrB.createTnc({ name: 'B', type: 'agwpe', connection: { host: '127.0.0.1', port: agwPort } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: 'N0CALL-10', portNumber: 0 });
  const radioB = mgrB.addRadio(tncB.id, { callsign: 'W1ABC-10', portNumber: 0 });

  const portInfoEvents = [];
  mgrA.on('port-info', (e) => portInfoEvents.push(e));

  mgrA.connectTnc(tncA.id);
  mgrB.connectTnc(tncB.id);
  await wait(200);

  await test('AGWPE port-info query/response round-trips through the real adapter', async () => {
    assert.ok(portInfoEvents.length > 0, 'should have received a port-info event');
    assert.ok(portInfoEvents[0].ports.some((p) => p.includes('Fake Radio Port')), 'port description should come through');
  });

  const monitorB = [];
  mgrB.on('monitor', (e) => monitorB.push(e));

  await test('unproto (UI) frame is sent and received over the real AGWPE stack', async () => {
    mgrA.sendUnproto(tncA.id, radioA.id, 'W1ABC-10', 'CQ over AGWPE');
    await wait(150);
    const heard = monitorB.find((e) => e.frameType === 'ui' && e.text === 'CQ over AGWPE');
    assert.ok(heard, 'Node B should have heard the UI frame relayed by the fake AGWPE server');
  });

  // ---- Connected-mode sessions: real AgwpeBridgeServer as the AGWPE server ----
  // A totally separate topology from the UI test above (its own TNC
  // managers, own loopback) — see the file header for why the fake
  // K-relay-only server above can't be reused for this.
  const kissLoopbackPort = 19700 + Math.floor(Math.random() * 1000);
  const kissLoopback = await new Promise((resolve) => {
    const clients = [];
    const srv = net.createServer((socket) => {
      clients.push(socket);
      socket.on('data', (data) => { for (const other of clients) if (other !== socket && !other.destroyed) other.write(data); });
      socket.on('error', () => {});
    });
    srv.listen(kissLoopbackPort, '127.0.0.1', () => resolve(srv));
  });

  // The "radio" AgwpeBridgeServer will actually drive, and the "remote
  // gateway" station on the other end of the same loopback — both real
  // kiss-tcp TNCs on real (separate) TncManager instances, same pattern
  // used throughout this suite (test_agwpe_bridge.js, etc.).
  const mgrServer = new TncManager({});
  const tncServer = mgrServer.createTnc({ name: 'ServerRadio', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: kissLoopbackPort } });
  const radioServer = mgrServer.addRadio(tncServer.id, { callsign: 'N0CALL-10', portNumber: 0 });
  const mgrRemote = new TncManager({});
  const tncRemote = mgrRemote.createTnc({ name: 'Remote', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: kissLoopbackPort } });
  mgrRemote.addRadio(tncRemote.id, { callsign: 'W1ABC-10', portNumber: 0 });
  mgrServer.connectTnc(tncServer.id);
  mgrRemote.connectTnc(tncRemote.id);
  await wait(200);

  // No explicit accept step needed — TncManager already auto-accepts an
  // incoming SABM with a real UA, same as it does for Terminal/BBS/Chat.
  const sessionDataRemote = [];
  mgrRemote.on('session-data', (d) => sessionDataRemote.push(d));

  const bridge = new AgwpeBridgeServer({ tncManager: mgrServer, getRadio: () => ({ tncId: tncServer.id, radioId: radioServer.id }) });
  const bridgePort = await bridge.start();

  const mgrClient = new TncManager({});
  const tncClient = mgrClient.createTnc({ name: 'Client', type: 'agwpe', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioClient = mgrClient.addRadio(tncClient.id, { callsign: 'N0CALL-10', portNumber: 0 });
  mgrClient.connectTnc(tncClient.id);
  await wait(200);

  let sessionClientId;
  const sessionStatesClient = [];
  mgrClient.on('session-state', (s) => sessionStatesClient.push(s));

  await test('connected-mode session + I-frame delivery works through AgwpeAdapter -> a real AGWPE server (AgwpeBridgeServer) -> a real remote station', async () => {
    const snap = mgrClient.startSession(tncClient.id, radioClient.id, 'W1ABC-10');
    sessionClientId = snap.id;
    await wait(500);
    assert.ok(sessionStatesClient.find((s) => s.id === sessionClientId && s.state === 'connected'), 'session should connect');
    mgrClient.sendSessionText(sessionClientId, 'hello over AGWPE');
    await wait(300);
    assert.ok(sessionDataRemote.find((d) => d.text === 'hello over AGWPE'), 'the remote station should receive the typed text');
  });

  await test('endSession() on a native AGWPE session tears down the real remote session too', async () => {
    const remoteStates = [];
    mgrRemote.on('session-state', (s) => remoteStates.push(s));
    mgrClient.endSession(sessionClientId);
    await wait(300);
    assert.ok(remoteStates.some((s) => s.state === 'disconnected'), 'the remote station should see a real disconnect, not just the client giving up locally');
  });

  mgrServer.shutdown();
  mgrRemote.shutdown();
  mgrClient.shutdown();
  bridge.stop();
  kissLoopback.close();

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgrA.shutdown();
  mgrB.shutdown();
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

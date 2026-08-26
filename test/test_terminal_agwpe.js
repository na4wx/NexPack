#!/usr/bin/env node
// End-to-end test of the real TncManager + AgwpeAdapter stack against a
// minimal fake AGWPE server. Unlike the KISS-TCP/serial tests, there's no
// prior-art test double to reuse here (NexDigi never implemented real AGWPE
// at all) — this fake server speaks just enough of the protocol (accepts
// 'X' login, answers 'G' port-info queries, and relays 'K' raw-frame
// sends to every other connected client, like a shared radio bus) to prove
// AgwpeAdapter's header encode/decode and TncManager's routing are correct.
const assert = require('assert');
const net = require('net');
const { HEADER_LEN, buildAgwFrame } = require('../electron/main/adapters/AgwpeAdapter');
const TncManager = require('../electron/main/tnc/TncManager');

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

  let sessionAId;
  const sessionStatesA = [];
  mgrA.on('session-state', (s) => sessionStatesA.push(s));
  const sessionDataB = [];
  mgrB.on('session-data', (d) => sessionDataB.push(d));

  await test('connected-mode session + I-frame delivery works over the real AGWPE stack', async () => {
    const snap = mgrA.startSession(tncA.id, radioA.id, 'W1ABC-10');
    sessionAId = snap.id;
    await wait(200);
    assert.ok(sessionStatesA.find((s) => s.id === sessionAId && s.state === 'connected'), 'session should connect');
    mgrA.sendSessionText(sessionAId, 'hello over AGWPE');
    await wait(200);
    assert.ok(sessionDataB.find((d) => d.text === 'hello over AGWPE'), 'Node B should receive the typed text');
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgrA.shutdown();
  mgrB.shutdown();
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

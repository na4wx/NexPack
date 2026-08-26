#!/usr/bin/env node
// End-to-end test of the real TncManager + SerialKissAdapter stack, using
// `serialport`'s own officially-supported SerialPortMock (backed by
// @serialport/binding-mock) with two mock ports manually linked like a
// null-modem cable — the same hardware-free technique proven in the parent
// NexDigi repo's test_rftransport_serial_unit.js.
const assert = require('assert');

const serialportPath = require.resolve('serialport');
const realSerialportExports = require(serialportPath);
const { SerialPortMock } = realSerialportExports;
require.cache[serialportPath].exports = Object.assign({}, realSerialportExports, { SerialPort: SerialPortMock });

const TncManager = require('../electron/main/tnc/TncManager');

function linkMockSerialPorts(serialPortA, serialPortB) {
  const bindingA = serialPortA.port;
  const bindingB = serialPortB.port;
  const origWriteA = bindingA.write.bind(bindingA);
  const origWriteB = bindingB.write.bind(bindingB);
  bindingA.write = async (buf) => { const r = await origWriteA(buf); bindingB.emitData(Buffer.from(buf)); return r; };
  bindingB.write = async (buf) => { const r = await origWriteB(buf); bindingA.emitData(Buffer.from(buf)); return r; };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const { MockBinding } = require('@serialport/binding-mock');
  MockBinding.reset();
  MockBinding.createPort('/dev/MOCKTTY-A', {});
  MockBinding.createPort('/dev/MOCKTTY-B', {});

  const mgrA = new TncManager({});
  const mgrB = new TncManager({});
  const tncA = mgrA.createTnc({ name: 'A', type: 'serial', connection: { path: '/dev/MOCKTTY-A', baud: 9600 } });
  const tncB = mgrB.createTnc({ name: 'B', type: 'serial', connection: { path: '/dev/MOCKTTY-B', baud: 9600 } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: 'N0CALL-10', portNumber: 0 });
  const radioB = mgrB.addRadio(tncB.id, { callsign: 'W1ABC-10', portNumber: 0 });

  mgrA.connectTnc(tncA.id);
  mgrB.connectTnc(tncB.id);

  await new Promise((resolve) => {
    let openCount = 0;
    const onStatus = (mgr) => (e) => { if (e.status === 'connected' && ++openCount === 2) resolve(); };
    mgrA.on('tnc-status', onStatus(mgrA));
    mgrB.on('tnc-status', onStatus(mgrB));
  });

  const tA = mgrA.tncs.get(tncA.id);
  const tB = mgrB.tncs.get(tncB.id);
  linkMockSerialPorts(tA.adapter.port, tB.adapter.port);

  const monitorB = [];
  mgrB.on('monitor', (e) => monitorB.push(e));

  await test('unproto (UI) frame is sent and received over the real serial/mock-port stack', async () => {
    mgrA.sendUnproto(tncA.id, radioA.id, 'W1ABC-10', 'CQ over simulated serial');
    await wait(150);
    const heard = monitorB.find((e) => e.frameType === 'ui' && e.text === 'CQ over simulated serial');
    assert.ok(heard, 'Node B should have heard the UI frame over the mock serial link');
  });

  let sessionAId;
  const sessionStatesA = [];
  mgrA.on('session-state', (s) => sessionStatesA.push(s));
  const sessionDataB = [];
  mgrB.on('session-data', (d) => sessionDataB.push(d));

  await test('connected-mode session + I-frame delivery works over the real serial/mock-port stack', async () => {
    const snap = mgrA.startSession(tncA.id, radioA.id, 'W1ABC-10');
    sessionAId = snap.id;
    await wait(200);
    assert.ok(sessionStatesA.find((s) => s.id === sessionAId && s.state === 'connected'), 'session should connect');
    mgrA.sendSessionText(sessionAId, 'hello over serial');
    await wait(200);
    assert.ok(sessionDataB.find((d) => d.text === 'hello over serial'), 'Node B should receive the typed text');
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgrA.shutdown();
  mgrB.shutdown();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

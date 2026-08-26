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
  });

  await test('getStations() reflects the update', () => {
    const stations = aprs.getStations();
    assert.ok(stations.find((s) => s.callsign === 'N0CALL-9'));
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

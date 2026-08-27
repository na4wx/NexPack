#!/usr/bin/env node
// Real end-to-end test of YAPP file transfer over a real TCP-bridged
// two-TncManager KISS loopback: actual AX.25 I-frames carry the actual
// YAPP protocol bytes between two real TncManager instances.
const assert = require('assert');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
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
const waitUntil = async (fn, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (fn()) return true; await wait(50); }
  return false;
};

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const bridgePort = 19900 + Math.floor(Math.random() * 1000);
  const bridge = await startBridge(bridgePort);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-yapp-test-'));

  const mgrA = new TncManager({});
  const mgrB = new TncManager({});
  const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const tncB = mgrB.createTnc({ name: 'B', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: 'N0CALL-9', portNumber: 0 });
  mgrB.addRadio(tncB.id, { callsign: 'W1ABC-10', portNumber: 0 });

  mgrA.connectTnc(tncA.id);
  mgrB.connectTnc(tncB.id);
  await wait(200);

  const snap = mgrA.startSession(tncA.id, radioA.id, 'W1ABC-10');
  const sessionAId = snap.id;
  await wait(200);
  const sessionBId = Array.from(mgrB.sessions.values())[0].id;

  // --- accepted binary transfer, byte-identical round trip ---
  const binaryFile = path.join(scratchDir, 'test.bin');
  const binaryContent = Buffer.concat([Buffer.from('binary test '), Buffer.from([0x00, 0xFF, 0x10, 0x02, 0x05, 0x06, 0x15, 0x18]), Buffer.from('x'.repeat(600))]);
  fs.writeFileSync(binaryFile, binaryContent);
  const savePath = path.join(scratchDir, 'received.bin');

  const offersB = [];
  mgrB.on('file-transfer-offer', (e) => offersB.push(e));
  const completesA = [], completesB = [];
  mgrA.on('file-transfer-complete', (e) => completesA.push(e));
  mgrB.on('file-transfer-complete', (e) => completesB.push(e));

  await test('sender offers a file and receiver gets a real offer event with filename/size', async () => {
    mgrA.startFileSend(sessionAId, binaryFile);
    const got = await waitUntil(() => offersB.length > 0);
    assert.ok(got, 'B should have received a file-transfer-offer');
    assert.strictEqual(offersB[0].filename, 'test.bin');
    assert.strictEqual(offersB[0].totalBytes, binaryContent.length);
  });

  await test('accepting the offer transfers the file byte-identically, including control-code-colliding bytes', async () => {
    mgrB.respondToFileOffer(sessionBId, true, savePath);
    const done = await waitUntil(() => completesA.length > 0 && completesB.length > 0);
    assert.ok(done, 'both sides should report file-transfer-complete');
    assert.ok(fs.existsSync(savePath), 'the received file should exist on disk');
    const received = fs.readFileSync(savePath);
    assert.ok(received.equals(binaryContent), 'received bytes should exactly match the sent bytes');
  });

  await test('both sessions revert to text mode and can send normal text again', async () => {
    const sA = Array.from(mgrA.sessions.values()).find((s) => s.id === sessionAId);
    const sB = Array.from(mgrB.sessions.values()).find((s) => s.id === sessionBId);
    assert.strictEqual(sA.mode, 'text');
    assert.strictEqual(sB.mode, 'text');
    const dataB = [];
    mgrB.on('session-data', (d) => dataB.push(d));
    mgrA.sendSessionText(sessionAId, 'back to normal text');
    const got = await waitUntil(() => dataB.some((d) => d.text === 'back to normal text'));
    assert.ok(got, 'plain text should work again after the transfer completes');
  });

  // --- reject path ---
  const errorsA = [];
  mgrA.on('file-transfer-error', (e) => errorsA.push(e));
  const smallFile = path.join(scratchDir, 'rejected.txt');
  fs.writeFileSync(smallFile, 'nope');

  await test('rejecting an offer reports an error on the sender and both sessions stay usable', async () => {
    offersB.length = 0;
    mgrA.startFileSend(sessionAId, smallFile);
    await waitUntil(() => offersB.length > 0);
    mgrB.respondToFileOffer(sessionBId, false);
    const got = await waitUntil(() => errorsA.length > 0);
    assert.ok(got, 'sender should see a file-transfer-error after rejection');
    const sA = Array.from(mgrA.sessions.values()).find((s) => s.id === sessionAId);
    const sB = Array.from(mgrB.sessions.values()).find((s) => s.id === sessionBId);
    assert.strictEqual(sA.mode, 'text');
    assert.strictEqual(sB.mode, 'text');
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgrA.shutdown();
  mgrB.shutdown();
  bridge.close();
  fs.rmSync(scratchDir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

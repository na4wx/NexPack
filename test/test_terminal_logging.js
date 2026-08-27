#!/usr/bin/env node
// Real end-to-end test of session disk logging: two real TncManager
// instances over a TCP-bridged KISS loopback, one constructed with a real
// (throwaway) userDataDir so its SessionLogger writes an actual file.
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
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const bridgePort = 19800 + Math.floor(Math.random() * 1000);
  const bridge = await startBridge(bridgePort);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-log-test-'));

  const mgrA = new TncManager({ userDataDir });
  const mgrB = new TncManager({});
  const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const tncB = mgrB.createTnc({ name: 'B', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: 'N0CALL-9', portNumber: 0 });
  mgrB.addRadio(tncB.id, { callsign: 'W1ABC-10', portNumber: 0 });

  mgrA.connectTnc(tncA.id);
  mgrB.connectTnc(tncB.id);
  await wait(200);

  let sessionAId, logPath;

  await test('a connected session opens a real log file under userDataDir/logs', async () => {
    const snap = mgrA.startSession(tncA.id, radioA.id, 'W1ABC-10');
    sessionAId = snap.id;
    await wait(200);
    const session = Array.from(mgrA.sessions.values()).find((s) => s.id === sessionAId);
    logPath = session.logPath;
    assert.ok(logPath, 'session should have a logPath once connected');
    assert.ok(logPath.startsWith(path.join(userDataDir, 'logs')), 'log should live under userDataDir/logs');
    assert.ok(fs.existsSync(logPath), 'the log file should actually exist on disk');
  });

  await test('sent and received text both land in the log file', async () => {
    mgrA.sendSessionText(sessionAId, 'outgoing test line');
    await wait(150);
    mgrB.sendSessionText(Array.from(mgrB.sessions.values())[0].id, 'incoming test line');
    await wait(150);
    const contents = fs.readFileSync(logPath, 'utf8');
    assert.ok(contents.includes('TX> outgoing test line'), 'log should contain the sent line');
    assert.ok(contents.includes('RX< incoming test line'), 'log should contain the received line');
  });

  await test('the log file is flushed and closed after disconnect', async () => {
    mgrA.endSession(sessionAId);
    await wait(150);
    const contents = fs.readFileSync(logPath, 'utf8');
    assert.ok(contents.length > 0, 'log file should still be readable and non-empty after close');
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgrA.shutdown();
  mgrB.shutdown();
  bridge.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

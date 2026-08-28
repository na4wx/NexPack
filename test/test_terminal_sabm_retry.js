#!/usr/bin/env node
// Real end-to-end test of SABM retry: a connect to a station that never
// answers must resend the SABM multiple times (not just once) before
// eventually giving up and reporting a real error — the exact gap
// reported live against a real LinBPQ node (SABM sent exactly once, then
// silence forever, no feedback). Retry interval is shortened via the
// constructor override so this doesn't take the real ~36s worst case.
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
  const bridgePort = 20200 + Math.floor(Math.random() * 1000);
  const bridge = await startBridge(bridgePort);

  // Short retry interval, small retry count — real behavior, fast test.
  const mgrA = new TncManager({ sabmRetryMs: 150, sabmRetryCount: 3 });
  const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: 'N0CALL-9', portNumber: 0 });
  mgrA.connectTnc(tncA.id);
  await wait(200);

  // Note: no station B at all — GHOST-1 never answers, on purpose.
  const sabmSends = [];
  mgrA.on('monitor', (e) => { if (e.direction === 'tx' && e.frameType === 'sabm') sabmSends.push(e); });
  const sessionErrors = [];
  mgrA.on('session-error', (e) => sessionErrors.push(e));
  const sessionStates = [];
  mgrA.on('session-state', (s) => sessionStates.push(s));

  let sessionId;
  await test('connecting to a non-responding station retries the SABM multiple times, not just once', async () => {
    const snap = mgrA.startSession(tncA.id, radioA.id, 'GHOST-1');
    sessionId = snap.id;
    // 1 initial send + 3 retries = 4 total, each 150ms apart -> wait past all of them
    await wait(150 * 3 + 300);
    assert.strictEqual(sabmSends.length, 4, `expected 1 initial + 3 retries = 4 SABM sends, got ${sabmSends.length}`);
  });

  await test('after exhausting retries, the session reports a real error and goes disconnected', async () => {
    assert.strictEqual(sessionErrors.length, 1, 'should have emitted exactly one session-error');
    assert.strictEqual(sessionErrors[0].sessionId, sessionId);
    assert.ok(/no response/i.test(sessionErrors[0].message), `error message should say "no response", got: ${sessionErrors[0].message}`);
    const finalState = sessionStates.filter((s) => s.id === sessionId).pop();
    assert.strictEqual(finalState.state, 'disconnected', 'session should end in disconnected state, not hang in connecting forever');
    assert.strictEqual(mgrA.sessions.size, 0, 'the dead session should be cleaned up, not left lingering');
  });

  await test('no further SABM retries fire after giving up', async () => {
    const countAfterGiveUp = sabmSends.length;
    await wait(150 * 2);
    assert.strictEqual(sabmSends.length, countAfterGiveUp, 'no more SABM frames should be sent once retries are exhausted');
  });

  // --- a real UA response cancels the retry timer, no extra sends after connect ---
  const mgrB = new TncManager({ sabmRetryMs: 150, sabmRetryCount: 3 });
  const tncB = mgrB.createTnc({ name: 'B', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  mgrB.addRadio(tncB.id, { callsign: 'W1ABC-10', portNumber: 0 });
  mgrB.connectTnc(tncB.id);
  await wait(200);

  const sabmSendsA2 = [];
  mgrA.on('monitor', (e) => { if (e.direction === 'tx' && e.frameType === 'sabm') sabmSendsA2.push(e); });

  await test('a real UA response stops the retry timer immediately (no wasted retries after success)', async () => {
    const snap = mgrA.startSession(tncA.id, radioA.id, 'W1ABC-10');
    await wait(300); // real SABM/UA handshake should complete well within one retry interval
    const state = Array.from(mgrA.sessions.values()).find((s) => s.id === snap.id);
    assert.ok(state && state.state === 'connected', 'session should be connected');
    const sendsSoFar = sabmSendsA2.length;
    await wait(150 * 2); // long enough that retries WOULD have fired if not cleared
    assert.strictEqual(sabmSendsA2.length, sendsSoFar, 'no additional SABM sends after a successful connect');
    mgrA.endSession(snap.id);
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgrA.shutdown();
  mgrB.shutdown();
  bridge.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

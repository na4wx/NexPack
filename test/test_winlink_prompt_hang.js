#!/usr/bin/env node
// Real end-to-end regression test for the actual root cause of a live report
// ("winlink RF connect times out after 60s, zero SABM ever transmitted, same
// TNC/radio that works fine for Terminal/APRS"). Root-caused by driving the
// REAL bundled pat binary through a real AgwpeBridgeServer + TncManager over
// a real kiss-tcp loopback (not a synthetic AGWPE client, and not just
// PatManager's own config-writing logic — neither test_agwpe_bridge.js nor
// the old test_winlink_rf_radio.js would ever exercise this): pat's
// connect.go calls promptUnconfirmedAccount() at the very START of EVERY
// connect, for ANY transport, before it ever touches AGWPE/the bridge/the
// radio at all. When cmsapi.AccountExists() can't confirm the configured
// mycall/SSID (any callsign+SSID pat has never seen succeed before — e.g. a
// brand-new SSID given to Winlink RF specifically, exactly what this app's
// own Settings > Winlink page recommends: "Give Winlink its own SSID... N0CALL-10"),
// pat sends a real-time-only prompt over its /ws socket (api/wshub.go's
// Prompt()) and blocks indefinitely waiting for a "prompt_response" that
// NexPack's own UI never spoke that protocol well enough to send — a
// TOTALLY silent hang (zero AGWPE bytes, zero SABM) until PatManager's own
// 60s backstop fires. Confirmed directly: an already-confirmed callsign
// connects through the bridge instantly; a fresh one hung >60s with zero
// bridge activity, on an otherwise identical setup. PatManager.js's
// _handlePrompt()/_respondPrompt() now auto-answer any such prompt the
// instant it arrives.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const TncManager = require('../electron/main/tnc/TncManager');
const AgwpeBridgeServer = require('../electron/main/winlink/AgwpeBridgeServer');
const PatManager = require('../electron/main/winlink/PatManager');

function startKissBridge(port) {
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
  // Skip gracefully in any environment without a real `pat` binary on PATH
  // (matches the convention already used by the other real-pat tests).
  const { execFileSync } = require('child_process');
  try { execFileSync('pat', ['version'], { stdio: 'ignore' }); } catch (e) {
    console.log('⚠️  SKIPPED (no `pat` binary on PATH): ' + path.basename(__filename));
    process.exit(0);
  }

  await test('a brand-new, never-confirmed callsign/SSID connects through the real bridge within a few seconds, not the 60s backstop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-prompt-hang-test-'));
    const bridgePort = 19700 + Math.floor(Math.random() * 1000);
    await startKissBridge(bridgePort);

    // A callsign+SSID guaranteed to never have a real, cached Winlink
    // account-confirmed state — this is exactly what triggers pat's
    // pre-account-activation prompt.
    const freshCall = `N0TEST-${Math.floor(Math.random() * 90) + 10}`;

    const mgrA = new TncManager({});
    const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
    const radioA = mgrA.addRadio(tncA.id, { callsign: freshCall, name: 'Winlink', portNumber: 0 });

    const mgrB = new TncManager({});
    const tncB = mgrB.createTnc({ name: 'B', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
    mgrB.addRadio(tncB.id, { callsign: 'WB4GBI-10', name: 'Gateway', portNumber: 0 });

    mgrA.connectTnc(tncA.id);
    mgrB.connectTnc(tncB.id);
    await wait(300);

    const bridge = new AgwpeBridgeServer({ tncManager: mgrA, getRadio: () => ({ tncId: tncA.id, radioId: radioA.id }) });
    let bridgeActivityMs = null;
    const start = Date.now();
    bridge.on('log', (line) => { if (bridgeActivityMs === null && /pat connected to the bridge/.test(line)) bridgeActivityMs = Date.now() - start; });
    const agwpePort = await bridge.start();

    const patMgr = new PatManager({ userDataDir: dir, agwpeBridgePort: agwpePort });
    let sawPromptAutoAnswer = false;
    patMgr.on('log', (line) => { if (/pat asked: pre-account-activation/.test(line)) sawPromptAutoAnswer = true; });
    await patMgr.saveSettings({ callsign: freshCall, winlinkPassword: '', connectAliases: {}, rfRadio: { tncId: tncA.id, radioId: radioA.id } });
    await patMgr.start();

    let result;
    try { result = await patMgr.connect('ax25:///WB4GBI-10'); } catch (e) { result = e; }
    const elapsedMs = Date.now() - start;

    assert.ok(sawPromptAutoAnswer, 'PatManager should have auto-answered a pre-account-activation prompt');
    // The real bug: pat never even reaches the bridge (zero AGWPE traffic)
    // for the entire 60s hang. The fix's signature is the bridge hearing
    // from pat almost immediately, regardless of how long the subsequent
    // (unrelated, real B2F protocol) exchange against a non-cooperating
    // test remote takes.
    assert.ok(bridgeActivityMs !== null && bridgeActivityMs < 5000, `pat should reach the bridge almost immediately, took ${bridgeActivityMs}ms`);
    // Real bug reproduced as a full 60000ms+ hang with the CONNECT_TIMEOUT_MS
    // backstop message; the real fix always resolves via a genuine B2F-layer
    // outcome well before that backstop, never via the timeout path itself.
    assert.ok(elapsedMs < 55000, `expected to resolve well before the 60s backstop, took ${elapsedMs}ms`);
    if (result instanceof Error) assert.ok(!/timed out/.test(result.message), `should not be the 60s timeout path, got: ${result.message}`);

    await patMgr.stop();
    bridge.stop();
    mgrA.shutdown();
    mgrB.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

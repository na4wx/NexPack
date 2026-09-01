#!/usr/bin/env node
// Real (no mocks) coverage for the new unified Settings screen's
// main-process pieces: TerminalSettings (previously nothing persisted a
// default radio/path at all) and BBS/Chat's callsign decoupling (they used
// to share the exact same callsign field/storage — Chat now has its own,
// while still sharing the host/password since that's genuinely one NexDigi
// server connection).
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TerminalSettings = require('../electron/main/settings/TerminalSettings');
const NexDigiClient = require('../electron/main/bbs/NexDigiClient');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-settings-test-'));

  await test('TerminalSettings has sane defaults before anything is saved', async () => {
    const ts = new TerminalSettings({ userDataDir: dir });
    const s = ts.getSettings();
    assert.strictEqual(s.defaultTncId, null);
    assert.strictEqual(s.defaultRadioId, null);
    assert.strictEqual(s.defaultDigiPath, '');
  });

  await test('TerminalSettings persists a default radio/path across instances', async () => {
    const ts = new TerminalSettings({ userDataDir: dir });
    ts.saveSettings({ defaultTncId: 'tnc-1', defaultRadioId: 'radio-1', defaultDigiPath: 'WIDE1-1,WIDE2-1' });
    const reloaded = new TerminalSettings({ userDataDir: dir });
    const s = reloaded.getSettings();
    assert.strictEqual(s.defaultTncId, 'tnc-1');
    assert.strictEqual(s.defaultRadioId, 'radio-1');
    assert.strictEqual(s.defaultDigiPath, 'WIDE1-1,WIDE2-1');
  });

  await test('BBS and Chat callsigns are independent, but saving one does not wipe the other', async () => {
    const client = new NexDigiClient({ userDataDir: dir });
    client.saveSettings({ host: 'localhost:3010', password: 'secret', callsign: 'N0CALL' });
    // Chat panel saves only host/password/chatCallsign — must not clobber BBS's callsign.
    client.saveSettings({ host: 'localhost:3010', password: 'secret', chatCallsign: 'N0CALL-5' });
    const s = client.getSettings();
    assert.strictEqual(s.callsign, 'N0CALL', 'BBS callsign should survive a Chat-only save');
    assert.strictEqual(s.chatCallsign, 'N0CALL-5');
  });

  await test('the reverse also holds: a BBS-only save does not wipe an existing chatCallsign', async () => {
    const client = new NexDigiClient({ userDataDir: dir });
    client.saveSettings({ host: 'localhost:3010', password: 'secret', callsign: 'N0CALL', chatCallsign: 'N0CALL-5' });
    client.saveSettings({ host: 'localhost:3010', password: 'secret', callsign: 'N0CALL-9' }); // BBS panel's own save shape
    const s = client.getSettings();
    assert.strictEqual(s.callsign, 'N0CALL-9');
    assert.strictEqual(s.chatCallsign, 'N0CALL-5', 'chatCallsign should survive a BBS-only save');
  });

  await test('ChatManager falls back to the BBS callsign only when chatCallsign was never set', async () => {
    const ChatManager = require('../electron/main/chat/ChatManager');
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-settings-test-'));
    const client = new NexDigiClient({ userDataDir: freshDir });
    client.saveSettings({ host: 'localhost:3010', password: 'secret', callsign: 'N0CALL-LEGACY' });
    const cm = new ChatManager({ nexDigiClient: client });
    assert.strictEqual(cm._chatCallsign(client.getSettings()), 'N0CALL-LEGACY', 'pre-existing settings with no chatCallsign should still work');

    client.saveSettings({ host: 'localhost:3010', password: 'secret', chatCallsign: 'N0CALL-CHAT' });
    assert.strictEqual(cm._chatCallsign(client.getSettings()), 'N0CALL-CHAT', 'chatCallsign should win once set, even with a BBS callsign also present');
    fs.rmSync(freshDir, { recursive: true, force: true });
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

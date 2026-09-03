#!/usr/bin/env node
// PatManager no longer resolves a real external AGWPE endpoint itself —
// it always points pat at NexPack's own AgwpeBridgeServer (see
// AgwpeBridgeServer.js and test_agwpe_bridge.js for the actual radio-
// driving logic). These tests cover PatManager's own remaining
// responsibility here: writing the right agwpe.addr into pat's config
// (always the bridge port it was given), and persisting which radio the
// bridge should use (read live by the bridge on every connect, not baked
// into pat's config).
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const PatManager = require('../electron/main/winlink/PatManager');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-winlink-rf-radio-test-'));

  await test('with no agwpeBridgePort given, saveSettings() falls back to the old default address', async () => {
    const mgr = new PatManager({ userDataDir: dir });
    await mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: '', connectAliases: {} });
    assert.deepStrictEqual(mgr.getSettings().agwpe, { addr: '127.0.0.1:8000', radio_port: 0 });
  });

  await test('saveSettings() always points pat at the given AgwpeBridgeServer port, not a real external TNC', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-winlink-rf-radio-test2-'));
    const mgr = new PatManager({ userDataDir: dir2, agwpeBridgePort: 54321 });
    await mgr.saveSettings({ callsign: 'NA4WX', winlinkPassword: '', connectAliases: {} });
    assert.deepStrictEqual(mgr.getSettings().agwpe, { addr: '127.0.0.1:54321', radio_port: 0 });
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  await test('saveSettings() does not await anything before writing the file — callers elsewhere rely on that', async () => {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-winlink-rf-radio-test3-'));
    const mgr = new PatManager({ userDataDir: dir3, agwpeBridgePort: 12345 });
    mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: 'SYNCTEST', connectAliases: {} }); // deliberately not awaited
    assert.strictEqual(mgr.getSettings().secure_login_password, 'SYNCTEST');
    fs.rmSync(dir3, { recursive: true, force: true });
  });

  await test('the chosen rfRadio (which the bridge reads live) persists across a fresh PatManager instance', async () => {
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-winlink-rf-radio-test4-'));
    const mgr1 = new PatManager({ userDataDir: dir4, agwpeBridgePort: 11111 });
    await mgr1.saveSettings({ callsign: 'NA4WX', winlinkPassword: '', connectAliases: {}, rfRadio: { tncId: 'tnc-1', radioId: 'radio-1' } });

    const mgr2 = new PatManager({ userDataDir: dir4, agwpeBridgePort: 11111 });
    assert.deepStrictEqual(mgr2.getRfRadio(), { tncId: 'tnc-1', radioId: 'radio-1' });
    fs.rmSync(dir4, { recursive: true, force: true });
  });

  await test('an explicit rfRadio: null clears a previously saved radio', async () => {
    const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-winlink-rf-radio-test5-'));
    const mgr = new PatManager({ userDataDir: dir5, agwpeBridgePort: 22222 });
    await mgr.saveSettings({ callsign: 'NA4WX', winlinkPassword: '', connectAliases: {}, rfRadio: { tncId: 'tnc-1', radioId: 'radio-1' } });
    await mgr.saveSettings({ callsign: 'NA4WX', winlinkPassword: '', connectAliases: {}, rfRadio: null });
    assert.strictEqual(mgr.getRfRadio(), null);
    fs.rmSync(dir5, { recursive: true, force: true });
  });

  await test('saveSettings() with rfRadio omitted entirely (not present in the call) leaves a previously saved radio untouched', async () => {
    const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-winlink-rf-radio-test6-'));
    const mgr = new PatManager({ userDataDir: dir6, agwpeBridgePort: 33333 });
    await mgr.saveSettings({ callsign: 'NA4WX', winlinkPassword: '', connectAliases: {}, rfRadio: { tncId: 'tnc-1', radioId: 'radio-1' } });
    await mgr.saveSettings({ callsign: 'NA4WX', winlinkPassword: 'newpass', connectAliases: {} }); // no rfRadio key at all
    assert.deepStrictEqual(mgr.getRfRadio(), { tncId: 'tnc-1', radioId: 'radio-1' });
    fs.rmSync(dir6, { recursive: true, force: true });
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

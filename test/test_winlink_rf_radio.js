#!/usr/bin/env node
// Winlink RF no longer takes a raw AGWPE host/port typed into Settings —
// it picks one of NexPack's own already-configured radios (from TNCs &
// Radios) instead, same as Terminal/BBS/Chat. PatManager resolves that
// radio into a real AGWPE {addr, radio_port} for pat's config via
// TncManager.getAgwpeEndpoint() — only ever at start() time (not at
// saveSettings() — saveSettings() must stay synchronous through its file
// write since callers elsewhere call it without awaiting), since a
// 'soundmodem' radio's AGWPE port is only known once Direwolf is actually
// running, and re-resolving fresh on every start keeps it from going stale
// across restarts anyway.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const PatManager = require('../electron/main/winlink/PatManager');
const TncManager = require('../electron/main/tnc/TncManager');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-winlink-rf-radio-test-'));

  await test('saveSettings() with no rfRadio falls back to the default agwpe address, unchanged from before', async () => {
    const tncMgr = new TncManager({ userDataDir: dir });
    const mgr = new PatManager({ userDataDir: dir, tncManager: tncMgr });
    await mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: '', connectAliases: {} });
    assert.deepStrictEqual(mgr.getSettings().agwpe, { addr: '127.0.0.1:8000', radio_port: 0 });
  });

  await test('saveSettings() does not await any TNC resolution — the config write must stay synchronous for unawaited callers', async () => {
    // Several call sites elsewhere call saveSettings() without awaiting and
    // rely on the file already being correct by the very next line — this
    // pins that contract down directly rather than only implicitly via the
    // other tests happening to pass.
    const tncMgr = new TncManager({ userDataDir: dir });
    const mgr = new PatManager({ userDataDir: dir, tncManager: tncMgr });
    mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: 'SYNCTEST', connectAliases: {} }); // deliberately not awaited
    assert.strictEqual(mgr.getSettings().secure_login_password, 'SYNCTEST', 'the file should already be written synchronously, even without awaiting saveSettings()');
  });

  await test('start() resolves an rfRadio pointing at a real "agwpe" TNC into pat\'s actual configured host/port/radio_port', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-winlink-rf-radio-test2-'));
    const tncMgr = new TncManager({ userDataDir: dir2 });
    const tnc = tncMgr.createTnc({ name: 'Direwolf AGWPE', type: 'agwpe', connection: { host: '192.0.2.9', port: 8020 } });
    const radio = tncMgr.addRadio(tnc.id, { callsign: 'NA4WX-10', name: 'Winlink', portNumber: 1 });

    const mgr = new PatManager({ userDataDir: dir2, tncManager: tncMgr, resourcesPath: path.join(__dirname, '..') });
    await mgr.saveSettings({ callsign: 'NA4WX', winlinkPassword: '', connectAliases: {}, rfRadio: { tncId: tnc.id, radioId: radio.id } });
    assert.deepStrictEqual(mgr.getRfRadio(), { tncId: tnc.id, radioId: radio.id });

    try {
      await mgr.start();
      assert.deepStrictEqual(mgr.getSettings().agwpe, { addr: '192.0.2.9:8020', radio_port: 1 });
    } finally {
      await mgr.stop();
    }
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  await test('the chosen radio persists across a fresh PatManager instance (e.g. app restart) and is re-resolved fresh on start()', async () => {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-winlink-rf-radio-test3-'));
    const tncMgr = new TncManager({ userDataDir: dir3 });
    const tnc = tncMgr.createTnc({ name: 'Direwolf AGWPE', type: 'agwpe', connection: { host: '192.0.2.10', port: 8030 } });
    const radio = tncMgr.addRadio(tnc.id, { callsign: 'NA4WX-10', name: 'Winlink', portNumber: 0 });

    const mgr1 = new PatManager({ userDataDir: dir3, tncManager: tncMgr });
    await mgr1.saveSettings({ callsign: 'NA4WX', winlinkPassword: '', connectAliases: {}, rfRadio: { tncId: tnc.id, radioId: radio.id } });

    // Simulate the radio's address changing between app restarts (e.g. the
    // user re-pointed the same TNC entry at a different host) — start()
    // must re-resolve, not reuse whatever was written at save time.
    tncMgr.updateTnc(tnc.id, { connection: { host: '192.0.2.11', port: 9040 } });

    const mgr2 = new PatManager({ userDataDir: dir3, tncManager: tncMgr, resourcesPath: path.join(__dirname, '..') });
    assert.deepStrictEqual(mgr2.getRfRadio(), { tncId: tnc.id, radioId: radio.id }, 'radio choice should survive a fresh PatManager instance');
    try {
      await mgr2.start();
      assert.deepStrictEqual(mgr2.getSettings().agwpe, { addr: '192.0.2.11:9040', radio_port: 0 }, 'start() should re-resolve the radio\'s current address, not a stale one from save time');
    } finally {
      await mgr2.stop();
    }
    fs.rmSync(dir3, { recursive: true, force: true });
  });

  await test('an rfRadio pointing at a non-AGWPE-capable TNC (e.g. serial/kiss-tcp) resolves to no override at start() — pat can only speak AGWPE', async () => {
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-winlink-rf-radio-test4-'));
    const tncMgr = new TncManager({ userDataDir: dir4 });
    const tnc = tncMgr.createTnc({ name: 'Raw KISS-TCP', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: 8050 } });
    const radio = tncMgr.addRadio(tnc.id, { callsign: 'NA4WX-11', name: 'Terminal', portNumber: 0 });

    const mgr = new PatManager({ userDataDir: dir4, tncManager: tncMgr, resourcesPath: path.join(__dirname, '..') });
    await mgr.saveSettings({ callsign: 'NA4WX', winlinkPassword: '', connectAliases: {}, rfRadio: { tncId: tnc.id, radioId: radio.id } });
    try {
      await mgr.start();
      assert.deepStrictEqual(mgr.getSettings().agwpe, { addr: '127.0.0.1:8000', radio_port: 0 }, 'should fall back to the default, not fabricate an AGWPE address for a non-AGWPE radio');
    } finally {
      await mgr.stop();
    }
    fs.rmSync(dir4, { recursive: true, force: true });
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

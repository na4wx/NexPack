#!/usr/bin/env node
// Reproduces the real bug found during manual testing: pat reads its
// config once at startup and never hot-reloads it, so saving new Winlink
// settings (e.g. fixing a password typo) while pat is already running had
// no effect until the whole app was restarted — the file on disk was
// correct the entire time, but the live process kept authenticating with
// stale in-memory values. saveSettings() must restart pat when it's
// already running so changes take effect immediately.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-settings-restart-test-'));
  const mgr = new PatManager({ userDataDir: dir });
  await mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: 'OLDPASS', connectAliases: {} });
  await mgr.start();
  const pidBeforeChange = mgr.proc.pid;

  await test('saveSettings() while pat is running restarts it and the new value takes effect', async () => {
    await mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: 'NEWPASS', connectAliases: {} });
    assert.notStrictEqual(mgr.proc.pid, pidBeforeChange, 'a fresh process should have been spawned');
    // pat's own /api/config redacts the password field (sensible — even
    // localhost callers shouldn't be able to read secrets back out), so
    // verify indirectly: the pidfile must point at the NEW process (proving
    // a real restart happened, not just a config write), and the on-disk
    // config PatManager itself reads back must show the new value.
    const pidfilePid = parseInt(fs.readFileSync(mgr.pidFilePath, 'utf8'), 10);
    assert.strictEqual(pidfilePid, mgr.proc.pid, 'pidfile should track the restarted process');
    assert.strictEqual(mgr.getSettings().secure_login_password, 'NEWPASS', 'the config file itself should hold the new password');
  });

  await test('saveSettings() while pat is NOT running just writes the file, no restart attempted', async () => {
    await mgr.stop();
    const before = mgr.proc;
    await mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: 'ANOTHERPASS', connectAliases: {} });
    assert.strictEqual(mgr.proc, null, 'should not spawn a process just from saving settings while stopped');
    const onDisk = mgr.getSettings();
    assert.strictEqual(onDisk.secure_login_password, 'ANOTHERPASS', 'file should still be updated correctly');
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  await mgr.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

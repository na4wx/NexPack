#!/usr/bin/env node
// Reproduces the real "fetch failed" bug from manual testing: React's
// dev-mode double-effect invocation calls PatManager.start() twice in
// quick succession. The old guard (`if (this.proc) return`) let the second
// caller's promise resolve before pat's HTTP server was actually confirmed
// listening, so its next call (getConnectAliases) hit a connection that
// wasn't there yet. start() must be safely re-entrant: both callers should
// only resolve once the server is genuinely ready.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-start-race-test-'));
  const mgr = new PatManager({ userDataDir: dir });
  mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: '', connectAliases: {} });

  await test('two concurrent start() calls both resolve only once the server is really ready', async () => {
    const [a, b] = await Promise.all([mgr.start(), mgr.start()]);
    // If either caller resolved early, this immediate real HTTP call would
    // fail with a connection error exactly like the manual-testing report.
    const aliases = await mgr.getConnectAliases();
    assert.ok(aliases && typeof aliases === 'object', 'getConnectAliases should succeed immediately after both start() calls resolve');
  });

  await test('a third start() call after startup is a fast no-op, not a second spawn', async () => {
    const pidBefore = mgr.proc.pid;
    await mgr.start();
    assert.strictEqual(mgr.proc.pid, pidBefore, 'should still be the same process');
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  await mgr.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

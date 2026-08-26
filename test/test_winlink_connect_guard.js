#!/usr/bin/env node
// Verifies PatManager.connect()'s overlap guard: a second concurrent
// connect() call must fail fast and clearly rather than silently queuing
// behind the first (which is what made a stuck session look like NexPack
// itself hanging during manual testing).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-connect-guard-test-'));
  const mgr = new PatManager({ userDataDir: dir });
  mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: '', connectAliases: {} });
  await mgr.start();

  await test('a second connect() while one is in-flight is rejected immediately, not queued', async () => {
    // A bogus, unreachable connect target so the first call blocks for a
    // while inside pat (real network attempt) — long enough to prove the
    // second call fails fast rather than waiting behind it.
    const first = mgr.connect('telnet://N0CALL:x@10.255.255.1:1/wl2k').catch((e) => e);
    await new Promise((r) => setTimeout(r, 200)); // let the first request actually start
    const start = Date.now();
    let secondError = null;
    try { await mgr.connect('telnet://N0CALL:x@10.255.255.1:1/wl2k'); } catch (e) { secondError = e; }
    const elapsed = Date.now() - start;
    assert.ok(secondError, 'second connect() should reject');
    assert.ok(/already in progress/i.test(secondError.message), `expected an "already in progress" error, got: ${secondError.message}`);
    assert.ok(elapsed < 1000, `second call should fail fast (took ${elapsed}ms), not wait behind the first`);
    await mgr.disconnect(true).catch(() => {}); // unstick the first attempt so cleanup can proceed
    await first;
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  await mgr.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

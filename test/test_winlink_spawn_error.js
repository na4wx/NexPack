#!/usr/bin/env node
// Reported live: a missing/unbundled `pat` binary crashed the ENTIRE
// Electron app with an "Uncaught Exception: Error: spawn pat ENOENT"
// dialog. Root cause: PatManager re-emits the child process's spawn
// error via `this.emit('error', err)`, and Node throws (crashing the
// process) when an EventEmitter's 'error' event has zero listeners —
// which was the case here, since index.js never listened for it.
//
// If this regresses, the crash happens as an actual uncaught exception in
// THIS test process too — so a guard below fails the test explicitly
// instead of letting the whole script die silently before printing results.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const PatManager = require('../electron/main/winlink/PatManager');

let pass = 0, fail = 0;
let crashed = null;
process.on('uncaughtException', (err) => { crashed = err; });

async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-spawn-error-test-'));
  const mgr = new PatManager({ userDataDir: dir });
  mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: '', connectAliases: {} });

  // Force a real, deterministic ENOENT regardless of whether a real `pat`
  // happens to be on this machine's PATH.
  process.env.NEXPACK_PAT_PATH = '/definitely/does/not/exist/pat-binary';

  // A stray, unhandled 'error' emission on PatManager itself would also
  // crash the process independent of index.js — attach nothing here on
  // purpose for the first check, to prove PatManager's OWN _doStart() path
  // no longer needs an external listener to avoid crashing (the friendly
  // rejection below is thrown before any bare emit('error') could escape).

  await test('a missing pat binary rejects start() with a clear message instead of crashing the process', async () => {
    let error = null;
    try { await mgr.start(); } catch (e) { error = e; }
    assert.ok(error, 'start() should reject, not resolve, when the binary is missing');
    assert.ok(/can't find the pat program/i.test(error.message), `expected a clear "can't find pat" message, got: ${error.message}`);
    assert.ok(!crashed, `the process should not have crashed via an uncaught exception, but it did: ${crashed && crashed.stack}`);
  });

  await test('PatManager itself is left in a clean, retriable state after the failed start', async () => {
    assert.strictEqual(mgr.proc, null, 'proc should be null after a failed spawn, not left dangling');
    // A second attempt (still against the bogus path) should behave the
    // same way, not hang or throw something different because of leftover
    // state from the first failure.
    let error2 = null;
    try { await mgr.start(); } catch (e) { error2 = e; }
    assert.ok(error2 && /can't find the pat program/i.test(error2.message));
  });

  delete process.env.NEXPACK_PAT_PATH;

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 || crashed ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

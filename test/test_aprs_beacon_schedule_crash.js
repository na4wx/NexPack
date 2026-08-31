#!/usr/bin/env node
// Reported live: closing/using the app crashed with "Uncaught Exception:
// Error: My Station position is not set at AprsManager.beaconNow" thrown
// from inside the scheduled-beacon setInterval callback. beaconNow() throws
// synchronously whenever mycall/homePosition aren't set, which is a normal,
// reachable state (a user can enable scheduled beaconing before finishing
// My Station setup) — but nothing was catching it inside the timer, so it
// crashed the whole Electron process instead of just failing that one tick.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const AprsManager = require('../electron/main/aprs/AprsManager');
const TncManager = require('../electron/main/tnc/TncManager');

let pass = 0, fail = 0;
let crashed = null;
process.on('uncaughtException', (err) => { crashed = err; });

async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-beacon-crash-test-'));
  const tncManager = new TncManager({});
  const mgr = new AprsManager({ userDataDir: dir, tncManager });

  await test('a scheduled beacon with no home position set fails quietly instead of crashing the process', async () => {
    const errors = [];
    mgr.on('aprs-error', (e) => errors.push(e));

    // Enabled beacon schedule, callsign set, but home position left unset —
    // a real, reachable mid-setup state, not a contrived edge case.
    mgr.saveMyStation({ mycall: 'N0CALL', symbol: '/>', comment: '', homePosition: null, beacon: { enabled: true, intervalMinutes: 0.001, path: '', tncId: null, radioId: null } });

    await wait(200); // past a couple of the (60ms) scheduled intervals

    assert.ok(!crashed, `the process should not have crashed via an uncaught exception, but it did: ${crashed && crashed.stack}`);
    assert.ok(errors.length > 0, 'expected at least one aprs-error from the failed scheduled beacon attempts');
    assert.ok(/position is not set/i.test(errors[0].message), `expected a clear "position is not set" message, got: ${errors[0].message}`);
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgr.saveMyStation({ beacon: { enabled: false, intervalMinutes: 30, path: '', tncId: null, radioId: null } }); // stop the timer before exit
  tncManager.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 || crashed ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

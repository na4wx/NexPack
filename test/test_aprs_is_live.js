#!/usr/bin/env node
// Real connectivity test against the real, live APRS-IS network — not a
// mock. Connects receive-only (passcode -1), listens for a bounded window,
// and confirms at least one real station gets parsed into a valid record.
// Requires internet access; this is a standalone script (like the
// BBS/Winlink live tests), not part of `npm test`, since it depends on an
// external network resource.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TncManager = require('../electron/main/tnc/TncManager');
const AprsManager = require('../electron/main/aprs/AprsManager');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-aprs-is-test-'));
  const tncManager = new TncManager({});
  const aprs = new AprsManager({ userDataDir: dir, tncManager });
  aprs.saveSettings({ aprsIs: { enabled: true, host: 'noam.aprs2.net', port: 14580, callsign: 'N0CALL', passcode: '-1', filter: 'r/39.8/-98.6/1000' } });

  const statuses = [];
  aprs.on('aprs-is-status', (s) => statuses.push(s));

  await test('connects to the real APRS-IS network', async () => {
    aprs.connectAprsIs();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !statuses.find((s) => s.connected)) await wait(200);
    assert.ok(statuses.find((s) => s.connected), 'should have received a real connected status from APRS-IS');
  });

  await test('receives and correctly parses at least one real live station within 20s', async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && aprs.getStations().length === 0) await wait(500);
    const stations = aprs.getStations();
    assert.ok(stations.length > 0, 'should have parsed at least one real station from live APRS-IS traffic');
    const s = stations[0];
    assert.ok(s.callsign, 'station should have a callsign');
    console.log(`   (heard ${stations.length} real station(s) in the window, e.g. ${s.callsign})`);
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  aprs.shutdown();
  tncManager.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

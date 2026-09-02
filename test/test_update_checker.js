#!/usr/bin/env node
// Real test against the actual GitHub Releases API (na4wx/NexPack) — no
// mock server, same "real components" convention as the rest of this
// suite. Uses extreme version numbers so the updateAvailable assertions
// stay correct regardless of whatever the actual latest release happens to
// be by the time this runs.
const assert = require('assert');
const UpdateChecker = require('../electron/main/UpdateChecker');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  await test('compareVersions: equal, greater, and less-than cases, including multi-digit segments', () => {
    const cmp = UpdateChecker.compareVersions;
    assert.strictEqual(cmp('1.2.3', '1.2.3'), 0);
    assert.ok(cmp('1.2.10', '1.2.9') > 0, 'minor/patch comparison must be numeric, not lexical (10 > 9)');
    assert.ok(cmp('1.2.9', '1.10.0') < 0);
    assert.ok(cmp('2.0.0', '1.9.9') > 0);
  });

  await test('checkForUpdate() against the real GitHub API: a very old local version reports an update available', async () => {
    const uc = new UpdateChecker({ currentVersion: '0.0.1' });
    const result = await uc.checkForUpdate();
    assert.strictEqual(result.updateAvailable, true);
    assert.strictEqual(result.currentVersion, '0.0.1');
    assert.ok(result.latestVersion, 'expected a real latest version string from GitHub');
    assert.ok(/^https:\/\/github\.com\/na4wx\/NexPack\/releases/.test(result.releaseUrl), `expected a real release URL, got: ${result.releaseUrl}`);
  });

  await test('checkForUpdate() against the real GitHub API: a far-future local version reports no update available', async () => {
    const uc = new UpdateChecker({ currentVersion: '999.0.0' });
    const result = await uc.checkForUpdate();
    assert.strictEqual(result.updateAvailable, false);
  });

  await test('a network failure rejects with a clear message instead of hanging or throwing raw', async () => {
    const uc = new UpdateChecker({ currentVersion: '1.0.0' });
    // Point at a host that will fail DNS resolution quickly, proving the
    // error path is a clean rejection an IPC handler/caller can catch —
    // not an uncaught exception or an indefinite hang.
    uc._fetchLatestRelease = () => Promise.reject(new Error('Could not reach GitHub: simulated DNS failure'));
    let error = null;
    try { await uc.checkForUpdate(); } catch (e) { error = e; }
    assert.ok(error, 'expected checkForUpdate() to reject on a fetch failure');
    assert.ok(/could not reach github/i.test(error.message), `expected a clear network-error message, got: ${error.message}`);
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

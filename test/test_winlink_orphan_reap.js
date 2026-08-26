#!/usr/bin/env node
// Reproduces the real failure mode from manual testing: a previous NexPack
// process died without cleanly stopping its `pat` subprocess, leaving it
// orphaned and listening on a stale port. Verifies PatManager.start()
// detects and kills that leftover process (via the pidfile it writes)
// before spawning its own, and that stop() itself cleanly kills a process
// it owns without leaving anything behind.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const PatManager = require('../electron/main/winlink/PatManager');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-orphan-test-'));
  const mgr = new PatManager({ userDataDir: dir });
  mgr.saveSettings({ callsign: 'N0CALL', winlinkPassword: '', connectAliases: {} });

  await test('start() spawns pat and writes a pidfile', async () => {
    await mgr.start();
    assert.ok(mgr.proc, 'proc should be set');
    assert.ok(fs.existsSync(mgr.pidFilePath), 'pidfile should exist');
    const pid = parseInt(fs.readFileSync(mgr.pidFilePath, 'utf8'), 10);
    assert.strictEqual(pid, mgr.proc.pid, 'pidfile should contain the real pid');
    assert.ok(isAlive(pid), 'process should actually be running');
  });

  const orphanedPid = mgr.proc.pid;

  await test('simulating a crash (orphaning pat) leaves it running with a stale pidfile', async () => {
    // No mgr.stop() call here on purpose — this models the process tree
    // surviving an abrupt Electron exit (crash/force-quit), exactly what
    // happened in manual testing.
    assert.ok(isAlive(orphanedPid), 'orphaned pat should still be alive');
    assert.ok(fs.existsSync(mgr.pidFilePath), 'stale pidfile should still be on disk');
  });

  const mgr2 = new PatManager({ userDataDir: dir });
  const logs = [];
  mgr2.on('log', (l) => logs.push(l));

  await test('a fresh PatManager.start() reaps the orphaned process first', async () => {
    await mgr2.start();
    assert.ok(!isAlive(orphanedPid), 'orphaned process should have been killed');
    assert.ok(logs.some((l) => l.includes('leftover pat process')), 'should log that it reaped a stale process');
    assert.ok(mgr2.proc && isAlive(mgr2.proc.pid), 'the new instance should be running its own fresh process');
    assert.notStrictEqual(mgr2.proc.pid, orphanedPid, 'the new process must not be the same pid as the orphan');
  });

  await test('stop() cleanly kills the process and removes the pidfile', async () => {
    const pid = mgr2.proc.pid;
    await mgr2.stop();
    assert.ok(!isAlive(pid), 'process should be dead after stop()');
    assert.ok(!fs.existsSync(mgr2.pidFilePath), 'pidfile should be removed after stop()');
  });

  await test('a second start()/stop() cycle with no orphan present works cleanly (no false-positive reaping)', async () => {
    const mgr3 = new PatManager({ userDataDir: dir });
    const logs3 = [];
    mgr3.on('log', (l) => logs3.push(l));
    await mgr3.start();
    assert.ok(!logs3.some((l) => l.includes('leftover pat process')), 'should not claim to reap anything when nothing is orphaned');
    await mgr3.stop();
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

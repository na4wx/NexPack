#!/usr/bin/env node
// SoundModemManager wraps a real Direwolf subprocess as a sound-card TNC.
// Same crash-class risk as PatManager (spawn 'error' with zero listeners
// takes down the whole Electron process) plus its own logic worth pinning
// down for real: the direwolf.conf it generates, and that TncManager can
// actually drive a 'soundmodem' TNC end-to-end through a fake stand-in
// "direwolf" binary (a tiny real KISS-TCP server, not a mock) — proving the
// port-reservation/KISSPORT wiring and the KissTcpAdapter handoff are wired
// correctly without requiring Direwolf itself to be installed in CI.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const SoundModemManager = require('../electron/main/soundmodem/SoundModemManager');
const TncManager = require('../electron/main/tnc/TncManager');

let pass = 0, fail = 0;
let crashed = null;
process.on('uncaughtException', (err) => { crashed = err; });

async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

// A minimal stand-in for the real `direwolf` binary: parses KISSPORT out of
// the config file it's given and opens a real TCP server there that just
// accepts connections (enough to prove the port handoff into a
// KissTcpAdapter works — this test isn't about AX.25 framing, TncManager's
// own AX.25 tests already cover that against a real KissTcpAdapter).
function writeFakeDirewolf(dir) {
  const scriptPath = path.join(dir, 'fake-direwolf.js');
  fs.writeFileSync(scriptPath, `
const fs = require('fs');
const net = require('net');
const confPath = process.argv[process.argv.indexOf('-c') + 1];
const conf = fs.readFileSync(confPath, 'utf8');
const m = conf.match(/^KISSPORT (\\d+)/m);
const port = parseInt(m[1], 10);
const srv = net.createServer((sock) => { sock.on('data', () => {}); });
srv.listen(port, '127.0.0.1', () => { console.log('Ready to accept KISS TCP client on port ' + port); });
process.on('SIGTERM', () => process.exit(0));
`);
  fs.chmodSync(scriptPath, 0o755);
  const wrapperPath = path.join(dir, 'direwolf');
  fs.writeFileSync(wrapperPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(scriptPath)});\n`);
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-soundmodem-test-'));

  await test('config generation: default device, VOX PTT emits no PTT line', () => {
    const mgr = new SoundModemManager({ userDataDir: dir });
    const conf = mgr._buildConfig({ callsign: 'na4wx-9', pttMethod: 'vox', port: 12345 });
    assert.ok(/^ADEVICE - -$/m.test(conf), `expected default ADEVICE, got:\n${conf}`);
    assert.ok(/^MYCALL NA4WX-9$/m.test(conf), 'callsign should be uppercased');
    assert.ok(/^KISSPORT 12345$/m.test(conf));
    assert.ok(!/^PTT /m.test(conf), 'VOX should not emit a PTT directive (Direwolf has none)');
  });

  await test('config generation: named audio devices and CM108 PTT', () => {
    const mgr = new SoundModemManager({ userDataDir: dir });
    const conf = mgr._buildConfig({ audioInputDevice: 'USB Audio CODEC', audioOutputDevice: 'USB Audio CODEC', pttMethod: 'cm108', pttDevice: '/dev/hidraw3', callsign: 'n0call', port: 999 });
    assert.ok(/^ADEVICE USB Audio CODEC USB Audio CODEC$/m.test(conf));
    assert.ok(/^PTT CM108 \/dev\/hidraw3$/m.test(conf));
  });

  await test('config generation: RTS PTT on a serial port', () => {
    const mgr = new SoundModemManager({ userDataDir: dir });
    const conf = mgr._buildConfig({ pttMethod: 'rts', pttDevice: '/dev/ttyUSB0', port: 999 });
    assert.ok(/^PTT \/dev\/ttyUSB0 RTS$/m.test(conf));
  });

  await test('a missing direwolf binary rejects startFor() with a clear message instead of crashing', async () => {
    const mgr = new SoundModemManager({ userDataDir: dir });
    process.env.NEXPACK_DIREWOLF_PATH = '/definitely/does/not/exist/direwolf-binary';
    let error = null;
    try { await mgr.startFor('tnc-1', { pttMethod: 'none', callsign: 'N0CALL' }); } catch (e) { error = e; }
    delete process.env.NEXPACK_DIREWOLF_PATH;
    assert.ok(error, 'startFor() should reject when the binary is missing');
    assert.ok(/can't find "direwolf"/i.test(error.message), `expected a clear install-hint message, got: ${error.message}`);
    assert.ok(!mgr.isRunning('tnc-1'), 'a failed start should not leave an instance registered');
    assert.ok(!crashed, `process should not crash via uncaught exception: ${crashed && crashed.stack}`);
  });

  await test('startFor()/stopFor() against a real (fake) direwolf: opens and tears down the KISS port', async () => {
    const bin = writeFakeDirewolf(dir);
    process.env.NEXPACK_DIREWOLF_PATH = bin;
    const mgr = new SoundModemManager({ userDataDir: dir });
    const { port } = await mgr.startFor('tnc-2', { pttMethod: 'none', callsign: 'N0CALL' });
    assert.ok(port > 0);
    assert.ok(mgr.isRunning('tnc-2'));

    // Prove the port is actually open and accepting connections.
    await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => { sock.end(); resolve(); });
      sock.on('error', reject);
    });

    await mgr.stopFor('tnc-2');
    assert.ok(!mgr.isRunning('tnc-2'));
    delete process.env.NEXPACK_DIREWOLF_PATH;
  });

  await test('TncManager end-to-end: a "soundmodem" TNC connects through the fake direwolf and reaches status=connected', async () => {
    const bin = writeFakeDirewolf(dir);
    process.env.NEXPACK_DIREWOLF_PATH = bin;
    const smMgr = new SoundModemManager({ userDataDir: dir });
    const tncMgr = new TncManager({ userDataDir: dir, soundModemManager: smMgr });
    const tnc = tncMgr.createTnc({ name: 'Sound Card TNC', type: 'soundmodem', connection: { pttMethod: 'none' } });
    tncMgr.addRadio(tnc.id, { callsign: 'NA4WX-9', name: 'Node', portNumber: 0 });

    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for connected status')), 5000);
      tncMgr.on('tnc-status', ({ tncId, status, error }) => {
        if (tncId !== tnc.id) return;
        if (status === 'connected') { clearTimeout(timer); resolve(); }
        if (status === 'error') { clearTimeout(timer); reject(new Error(error || 'unknown error')); }
      });
    });
    await tncMgr.connectTnc(tnc.id);
    await connected;

    await tncMgr.disconnectTnc(tnc.id);
    assert.ok(!smMgr.isRunning(tnc.id), 'disconnecting a soundmodem TNC should stop its direwolf process');
    delete process.env.NEXPACK_DIREWOLF_PATH;
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 || crashed ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

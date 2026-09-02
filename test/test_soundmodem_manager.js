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

  await test('config generation: no device specified omits ADEVICE entirely (lets Direwolf apply its own per-OS default)', () => {
    // Verified against the real bundled binary: "-" is NOT a "use system
    // default" sentinel to Direwolf — it means "pipe raw audio via
    // stdin/stdout", a completely different (and useless here) mode. And
    // the real "use the default device" value differs per platform (empty
    // string on macOS/Windows, the literal word "default" for ALSA on
    // Linux) — so the only value correct on every platform is to not emit
    // an ADEVICE line at all when the user hasn't named a specific device.
    const mgr = new SoundModemManager({ userDataDir: dir });
    const conf = mgr._buildConfig({ callsign: 'na4wx-9', pttMethod: 'vox', port: 12345 });
    assert.ok(!/^ADEVICE/m.test(conf), `expected no ADEVICE line when no device was specified, got:\n${conf}`);
    assert.ok(/^MYCALL NA4WX-9$/m.test(conf), 'callsign should be uppercased');
    assert.ok(/^KISSPORT 12345$/m.test(conf));
    assert.ok(!/^PTT /m.test(conf), 'VOX should not emit a PTT directive (Direwolf has none)');
  });

  await test('config generation: named audio devices and CM108 PTT', () => {
    const mgr = new SoundModemManager({ userDataDir: dir });
    const conf = mgr._buildConfig({ audioInputDevice: 'USB Audio CODEC', audioOutputDevice: 'USB Audio CODEC', pttMethod: 'cm108', pttDevice: '/dev/hidraw3', callsign: 'n0call', port: 999 });
    // Quoted: device names routinely contain spaces, and Direwolf's config
    // tokenizer splits unquoted ADEVICE tokens on whitespace like a shell.
    assert.ok(/^ADEVICE "USB Audio CODEC" "USB Audio CODEC"$/m.test(conf), `got:\n${conf}`);
    assert.ok(/^PTT CM108 \/dev\/hidraw3$/m.test(conf));
  });

  await test('config generation: RTS PTT on a serial port', () => {
    const mgr = new SoundModemManager({ userDataDir: dir });
    const conf = mgr._buildConfig({ pttMethod: 'rts', pttDevice: '/dev/ttyUSB0', port: 999 });
    assert.ok(/^PTT \/dev\/ttyUSB0 RTS$/m.test(conf));
  });

  await test('_readAlsaCards() parses real-shaped /proc/asound/cards content into Direwolf-acceptable device tokens', () => {
    const mgr = new SoundModemManager({ userDataDir: dir });
    const sample = ' 0 [PCH            ]: HDA-Intel - HDA Intel PCH\n'
      + '                      HDA Intel PCH at 0xf7240000 irq 32\n'
      + ' 1 [USB            ]: USB-Audio - USB Audio CODEC\n'
      + '                      Generic USB Audio CODEC at usb-0000:00:14.0-1, full speed\n';
    const origRead = fs.readFileSync;
    fs.readFileSync = (p, enc) => (p === '/proc/asound/cards' ? sample : origRead(p, enc));
    let cards;
    try { cards = mgr._readAlsaCards(); } finally { fs.readFileSync = origRead; }
    assert.deepStrictEqual(cards.map((c) => c.name), ['plughw:CARD=PCH,DEV=0', 'plughw:CARD=USB,DEV=0']);
    assert.ok(cards[0].label.includes('HDA Intel PCH'));
    assert.ok(cards[1].label.includes('USB Audio CODEC'));
  });

  await test('_readAlsaCards() returns an empty list rather than throwing when /proc/asound/cards does not exist', () => {
    const mgr = new SoundModemManager({ userDataDir: dir });
    const origRead = fs.readFileSync;
    fs.readFileSync = (p, enc) => { if (p === '/proc/asound/cards') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return origRead(p, enc); };
    let cards;
    try { cards = mgr._readAlsaCards(); } finally { fs.readFileSync = origRead; }
    assert.deepStrictEqual(cards, []);
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
    try {
      const mgr = new SoundModemManager({ userDataDir: dir });
      // Explicit devices here so this test doesn't also exercise
      // _probeDefaultDevices — the fake stand-in doesn't speak Direwolf's
      // real device-listing protocol, that path has its own dedicated test.
      const { port } = await mgr.startFor('tnc-2', { audioInputDevice: 'fake-in', audioOutputDevice: 'fake-out', pttMethod: 'none', callsign: 'N0CALL' });
      assert.ok(port > 0);
      assert.ok(mgr.isRunning('tnc-2'));

      // Prove the port is actually open and accepting connections.
      await new Promise((resolve, reject) => {
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => { sock.end(); resolve(); });
        sock.on('error', reject);
      });

      await mgr.stopFor('tnc-2');
      assert.ok(!mgr.isRunning('tnc-2'));
    } finally {
      delete process.env.NEXPACK_DIREWOLF_PATH;
    }
  });

  await test('TncManager end-to-end: a "soundmodem" TNC connects through the fake direwolf and reaches status=connected', async () => {
    const bin = writeFakeDirewolf(dir);
    process.env.NEXPACK_DIREWOLF_PATH = bin;
    try {
      const smMgr = new SoundModemManager({ userDataDir: dir });
      const tncMgr = new TncManager({ userDataDir: dir, soundModemManager: smMgr });
      const tnc = tncMgr.createTnc({ name: 'Sound Card TNC', type: 'soundmodem', connection: { audioInputDevice: 'fake-in', audioOutputDevice: 'fake-out', pttMethod: 'none' } });
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
    } finally {
      delete process.env.NEXPACK_DIREWOLF_PATH;
    }
  });

  await test('_probeDefaultDevices() against the real bundled direwolf on this platform, if any: finds real default device names', async () => {
    const realBin = path.join(
      __dirname, '..', 'direwolf',
      process.platform === 'win32' ? 'win32' : path.join(process.platform, process.arch),
      process.platform === 'win32' ? 'direwolf.exe' : 'direwolf'
    );
    if (!fs.existsSync(realBin) || process.platform === 'linux' || process.platform === 'win32') {
      console.log('  (skipped — only meaningful against a real PortAudio-backed build on this platform)');
      return;
    }
    const mgr = new SoundModemManager({ userDataDir: dir });
    const result = await mgr._probeDefaultDevices(realBin);
    assert.ok(result, 'expected to detect real default input/output device names');
    assert.ok(result.input && result.input.length > 0);
    assert.ok(result.output && result.output.length > 0);
    // Cached: a second call should not re-spawn direwolf.
    const result2 = await mgr._probeDefaultDevices(realBin);
    assert.strictEqual(result2, result, 'expected the cached result to be reused');
  });

  await test('listAudioDevices() against the real bundled direwolf, if any: returns real, selectable device names', async () => {
    if (process.platform !== 'darwin') {
      console.log(`  (skipped — device enumeration only implemented for darwin in this test's platform, got ${process.platform})`);
      return;
    }
    const realBin = path.join(__dirname, '..', 'direwolf', process.platform, process.arch, 'direwolf');
    if (!fs.existsSync(realBin)) {
      console.log('  (skipped — no direwolf built for this platform/arch)');
      return;
    }
    const mgr = new SoundModemManager({ userDataDir: dir, resourcesPath: path.join(__dirname, '..') });
    const devices = await mgr.listAudioDevices();
    assert.ok(devices.inputs.length > 0, 'expected at least one real input device (the built-in mic, if nothing else)');
    assert.ok(devices.outputs.length > 0, 'expected at least one real output device (the built-in speakers, if nothing else)');
    assert.ok(devices.inputs.some((d) => d.isDefault), 'expected exactly one input flagged as the system default');
    assert.ok(devices.outputs.some((d) => d.isDefault), 'expected exactly one output flagged as the system default');

    // Prove these are names Direwolf will genuinely accept, not just
    // plausible-looking strings: start it for real against the detected
    // default input, quoted through the same _buildConfig path startFor()
    // uses, and confirm its KISS port actually opens.
    const defaultInput = devices.inputs.find((d) => d.isDefault).name;
    const defaultOutput = devices.outputs.find((d) => d.isDefault).name;
    const { port } = await mgr.startFor('list-devices-tnc', { audioInputDevice: defaultInput, audioOutputDevice: defaultOutput, pttMethod: 'none', callsign: 'N0CALL' });
    await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => { sock.end(); resolve(); });
      sock.on('error', reject);
    });
    await mgr.stopFor('list-devices-tnc');
  });

  await test('_reservePort() always returns a port Direwolf actually accepts (<= 49151)', async () => {
    // Regression test for a real bug found running the actual bundled
    // binary: listen(0) (ask the OS for any free ephemeral port) hands back
    // a port in the OS's ephemeral range, which on macOS starts at 49152 —
    // above Direwolf's KISSPORT limit, so it refused to start every single
    // time. _reservePort() has to pick its own candidate in range instead.
    const mgr = new SoundModemManager({ userDataDir: dir });
    for (let i = 0; i < 10; i++) {
      const port = await mgr._reservePort();
      assert.ok(port >= 1024 && port <= 49151, `port ${port} is outside Direwolf's accepted KISSPORT range`);
    }
  });

  const bundledBinary = path.join(
    __dirname, '..', 'direwolf',
    process.platform === 'win32' ? 'win32' : path.join(process.platform, process.arch),
    process.platform === 'win32' ? 'direwolf.exe' : 'direwolf'
  );
  if (fs.existsSync(bundledBinary)) {
    await test(`real bundled direwolf (${process.platform}/${process.arch}) actually starts and opens its KISS port`, async () => {
      const mgr = new SoundModemManager({ userDataDir: dir, resourcesPath: path.join(__dirname, '..') });
      assert.strictEqual(mgr._resolveBinaryPath(), bundledBinary);
      const { port } = await mgr.startFor('real-tnc', { pttMethod: 'none', callsign: 'N0CALL' });
      await new Promise((resolve, reject) => {
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => { sock.end(); resolve(); });
        sock.on('error', reject);
      });
      await mgr.stopFor('real-tnc');
    });
  } else {
    console.log(`(skipping real-bundled-binary test — no direwolf built for ${process.platform}/${process.arch} yet)`);
  }

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 || crashed ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

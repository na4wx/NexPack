#!/usr/bin/env node
// Real end-to-end test of AgwpeBridgeServer — the AGWPE server NexPack now
// runs so `pat` (which can only ever speak AGWPE, never raw KISS) can drive
// Winlink RF through ANY of NexPack's own configured radios, not just
// AGWPE-native ones. Deliberately uses a 'kiss-tcp' radio on the NexPack
// side below (not 'agwpe' or 'soundmodem') — that's the whole point of the
// bridge, and it would have been impossible to use for Winlink RF before.
//
// The synthetic AGWPE client here is not a mock of the bridge — it speaks
// the exact byte-level AGWPE frame format (36-byte header, same field
// layout) that was verified by capturing the REAL bundled `pat` binary's
// actual traffic against a real Direwolf AGWPE server (register 'X',
// version 'R', port-capabilities 'g', connect 'C' all matched byte-for-byte
// against the on7lds.net AGWPE API spec). Real pat's own connect flow is a
// blocking, one-shot HTTP call with no way to inject raw data mid-session
// from a test, which is why this test drives the bridge directly at the
// wire-protocol level instead — same technique already used throughout
// this suite (test_terminal_kisstcp.js, test_aprs_manager_rf.js) for
// exercising a real protocol stack without needing another vendor's binary
// on the other end.
const assert = require('assert');
const net = require('net');
const TncManager = require('../electron/main/tnc/TncManager');
const AgwpeBridgeServer = require('../electron/main/winlink/AgwpeBridgeServer');

function startKissBridge(port) {
  return new Promise((resolve) => {
    const clients = [];
    const server = net.createServer((socket) => {
      clients.push(socket);
      socket.on('data', (data) => { for (const other of clients) if (other !== socket && !other.destroyed) other.write(data); });
      socket.on('error', () => {});
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

const HEADER_LEN = 36;
function writeCall(str) {
  const buf = Buffer.alloc(10);
  buf.write(String(str || '').toUpperCase().slice(0, 9), 'ascii');
  return buf;
}
function buildFrame({ port = 0, kind, callFrom = '', callTo = '', payload = Buffer.alloc(0) }) {
  const header = Buffer.alloc(HEADER_LEN);
  header[0] = port & 0xff;
  header[4] = kind.charCodeAt(0);
  writeCall(callFrom).copy(header, 8);
  writeCall(callTo).copy(header, 18);
  header.writeUInt32LE(payload.length, 28);
  return Buffer.concat([header, payload]);
}

// A minimal, byte-accurate AGWPE client — see file header for why this
// (not the real pat binary) drives the protocol-level assertions below.
class TestAgwClient {
  constructor(port) {
    this.port = port;
    this.frames = [];
    this.buf = Buffer.alloc(0);
    this._waiters = [];
  }
  async connect() {
    this.sock = net.createConnection({ host: '127.0.0.1', port: this.port });
    this.sock.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      while (this.buf.length >= HEADER_LEN) {
        const dataLen = this.buf.readUInt32LE(28);
        if (this.buf.length < HEADER_LEN + dataLen) break;
        const header = this.buf.slice(0, HEADER_LEN);
        const payload = this.buf.slice(HEADER_LEN, HEADER_LEN + dataLen);
        this.buf = this.buf.slice(HEADER_LEN + dataLen);
        const frame = { kind: String.fromCharCode(header[4]), callFrom: header.slice(8, 18).toString('ascii').replace(/\0.*$/, ''), callTo: header.slice(18, 28).toString('ascii').replace(/\0.*$/, ''), payload };
        this.frames.push(frame);
        const waiter = this._waiters.find((w) => w.match(frame));
        if (waiter) { this._waiters.splice(this._waiters.indexOf(waiter), 1); waiter.resolve(frame); }
      }
    });
    await new Promise((resolve, reject) => { this.sock.once('connect', resolve); this.sock.once('error', reject); });
  }
  send(opts) { this.sock.write(buildFrame(opts)); }
  waitFor(matchFn, timeoutMs = 3000) {
    const existing = this.frames.find(matchFn);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._waiters = this._waiters.filter((w) => w.resolve !== resolve); reject(new Error('timed out waiting for AGWPE frame')); }, timeoutMs);
      this._waiters.push({ match: matchFn, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
  }
  close() { try { this.sock.destroy(); } catch (e) { /* ignore */ } }
}

async function main() {
  const bridgePort = 19700 + Math.floor(Math.random() * 1000);
  const kissBridge = await startKissBridge(bridgePort);

  // "NexPack side" — deliberately a plain 'kiss-tcp' radio, proving the
  // AGWPE bridge makes a non-AGWPE-native TNC usable for Winlink RF.
  const mgrA = new TncManager({});
  const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: 'NA4WX-10', name: 'Winlink', portNumber: 0 });

  // "Remote RMS gateway" stand-in — a real TncManager that auto-accepts an
  // incoming SABM (exactly like a real gateway/BBS would), used to prove
  // the bridge actually drives a real AX.25 handshake, not a canned reply.
  const mgrB = new TncManager({});
  const tncB = mgrB.createTnc({ name: 'B', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioB = mgrB.addRadio(tncB.id, { callsign: 'WB4GBI-10', name: 'Gateway', portNumber: 0 });
  mgrB.on('session-data', ({ sessionId, text }) => mgrB.sendSessionText(sessionId, `ECHO:${text}`));

  mgrA.connectTnc(tncA.id);
  mgrB.connectTnc(tncB.id);
  await wait(200);

  const bridge = new AgwpeBridgeServer({ tncManager: mgrA, getRadio: () => ({ tncId: tncA.id, radioId: radioA.id }) });
  const bridgePortAgw = await bridge.start();

  let client;

  await test('X (register callsign) is acknowledged', async () => {
    client = new TestAgwClient(bridgePortAgw);
    await client.connect();
    client.send({ kind: 'X', callFrom: 'NA4WX-10' });
    const reply = await client.waitFor((f) => f.kind === 'X');
    assert.strictEqual(reply.payload[0], 1, 'expected registration-successful byte (0x01)');
  });

  await test('R (version query) gets a reply', async () => {
    client.send({ kind: 'R' });
    const reply = await client.waitFor((f) => f.kind === 'R');
    assert.strictEqual(reply.payload.length, 8);
  });

  await test('C (connect) drives a real AX.25 SABM/UA handshake through TncManager and reports back "CONNECTED"', async () => {
    client.send({ kind: 'C', callFrom: 'NA4WX-10', callTo: 'WB4GBI-10' });
    const reply = await client.waitFor((f) => f.kind === 'C', 5000);
    assert.ok(/CONNECTED/i.test(reply.payload.toString('ascii')), `expected a CONNECTED message, got: ${reply.payload.toString('ascii')}`);
  });

  await test('D (send connected data) reaches the real remote station and its reply comes back as a D frame', async () => {
    client.frames = client.frames.filter((f) => f.kind !== 'D'); // clear anything from setup
    client.send({ kind: 'D', callFrom: 'NA4WX-10', callTo: 'WB4GBI-10', payload: Buffer.from('hello gateway', 'utf8') });
    const reply = await client.waitFor((f) => f.kind === 'D', 5000);
    assert.strictEqual(reply.payload.toString('utf8'), 'ECHO:hello gateway');
  });

  await test('d (disconnect request) tears down the real AX.25 session and is acknowledged with a d frame', async () => {
    client.frames = client.frames.filter((f) => f.kind !== 'd');
    client.send({ kind: 'd', callFrom: 'NA4WX-10', callTo: 'WB4GBI-10' });
    const reply = await client.waitFor((f) => f.kind === 'd', 5000);
    assert.ok(/DISCONNECTED/i.test(reply.payload.toString('ascii')));
  });

  await test('_ensureRadioConnected() actually waits for the real async "connected" status, not just for connectTnc()\'s promise', async () => {
    // Reported live: nothing transmitted at all on a real connect attempt,
    // and pat just hung until its own 120s timeout. Root cause —
    // TncManager.connectTnc() resolves as soon as it STARTS connecting a
    // serial/KISS-TCP/AGWPE radio, not once the adapter is actually open;
    // the old code called startSession() immediately after, which silently
    // dropped the very first SABM into a socket that wasn't ready yet.
    // This pins down the fix directly: the TNC here is deliberately NOT
    // pre-connected (unlike the setup above), so _ensureRadioConnected()
    // has to do the real work — and Node's net.Socket connect can only
    // ever resolve on a later tick, never synchronously, even on
    // localhost, so checking status immediately after calling reliably
    // proves it hasn't resolved prematurely.
    const mgrC = new TncManager({});
    const tncC = mgrC.createTnc({ name: 'C', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
    const radioC = mgrC.addRadio(tncC.id, { callsign: 'NA4WX-11', name: 'Winlink', portNumber: 0 });
    const bridgeC = new AgwpeBridgeServer({ tncManager: mgrC, getRadio: () => ({ tncId: tncC.id, radioId: radioC.id }) });

    const donePromise = bridgeC._ensureRadioConnected(tncC.id);
    const statusRightAfterCalling = mgrC.listTncs().find((t) => t.id === tncC.id).status;
    assert.notStrictEqual(statusRightAfterCalling, 'connected', 'should not already report connected synchronously — that would mean nothing was actually awaited');

    await donePromise;
    const statusAfterAwait = mgrC.listTncs().find((t) => t.id === tncC.id).status;
    assert.strictEqual(statusAfterAwait, 'connected');

    mgrC.shutdown();
  });

  await test('a connect issued before the radio is pre-connected still completes a real SABM/UA handshake (no dropped first frame)', async () => {
    const mgrD = new TncManager({});
    const tncD = mgrD.createTnc({ name: 'D', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
    const radioD = mgrD.addRadio(tncD.id, { callsign: 'NA4WX-12', name: 'Winlink', portNumber: 0 });
    const bridgeD = new AgwpeBridgeServer({ tncManager: mgrD, getRadio: () => ({ tncId: tncD.id, radioId: radioD.id }) });
    const bridgeDPort = await bridgeD.start();

    // mgrB (the "remote gateway" from the tests above) is still up and
    // listening on the shared KISS loopback — deliberately reused as the
    // real remote peer for this handshake too.
    const clientD = new TestAgwClient(bridgeDPort);
    await clientD.connect();
    clientD.send({ kind: 'X', callFrom: 'NA4WX-12' });
    await clientD.waitFor((f) => f.kind === 'X');
    // tncD has never had connectTnc() called on it before this point.
    clientD.send({ kind: 'C', callFrom: 'NA4WX-12', callTo: 'WB4GBI-10' });
    const reply = await clientD.waitFor((f) => f.kind === 'C', 5000);
    assert.ok(/CONNECTED/i.test(reply.payload.toString('ascii')), `expected a CONNECTED message, got: ${reply.payload.toString('ascii')}`);

    clientD.close();
    bridgeD.stop();
    mgrD.shutdown();
  });

  await test('a configured radio that can never actually connect (e.g. unreachable host) fails fast with the real error, not a 120s hang', async () => {
    // The scenario reported live: a radio WAS configured, so the "no radio
    // configured" fast path (below) never fired, yet the connect still
    // hung for the full 120s with nothing transmitted. Whatever the exact
    // trigger, _ensureRadioConnected() now bounds every such failure to a
    // real 'tnc-status':'error' event (or a 10s timeout) instead of only
    // ever surfacing via pat's own much longer external timeout.
    const mgrE = new TncManager({});
    const deadPort = 1; // nothing listening here — a real, fast ECONNREFUSED
    const tncE = mgrE.createTnc({ name: 'E', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: deadPort } });
    const radioE = mgrE.addRadio(tncE.id, { callsign: 'NA4WX-13', name: 'Winlink', portNumber: 0 });
    const bridgeE = new AgwpeBridgeServer({ tncManager: mgrE, getRadio: () => ({ tncId: tncE.id, radioId: radioE.id }) });
    const bridgeEPort = await bridgeE.start();

    const clientE = new TestAgwClient(bridgeEPort);
    await clientE.connect();
    clientE.send({ kind: 'X', callFrom: 'NA4WX-13' });
    await clientE.waitFor((f) => f.kind === 'X');
    const start = Date.now();
    clientE.send({ kind: 'C', callFrom: 'NA4WX-13', callTo: 'WB4GBI-10' });
    const reply = await clientE.waitFor((f) => f.kind === 'd', 15000);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 15000, `should fail well within pat's own 120s timeout (took ${elapsed}ms)`);
    assert.ok(!/no radio configured/i.test(reply.payload.toString('ascii')), 'this radio IS configured — the failure reason should reflect the real connection error');

    clientE.close();
    bridgeE.stop();
    mgrE.shutdown();
  });

  await test('a connect attempt with no radio configured fails fast with a clear reason instead of hanging', async () => {
    const bridge2 = new AgwpeBridgeServer({ tncManager: mgrA, getRadio: () => null });
    const port2 = await bridge2.start();
    const client2 = new TestAgwClient(port2);
    await client2.connect();
    client2.send({ kind: 'C', callFrom: 'NA4WX-10', callTo: 'WB4GBI-10' });
    const reply = await client2.waitFor((f) => f.kind === 'd', 3000);
    assert.ok(/no radio configured/i.test(reply.payload.toString('ascii')));
    client2.close();
    bridge2.stop();
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  if (client) client.close();
  bridge.stop();
  mgrA.shutdown();
  mgrB.shutdown();
  kissBridge.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

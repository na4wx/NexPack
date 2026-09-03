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

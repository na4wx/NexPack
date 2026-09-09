#!/usr/bin/env node
// Regression test for a live report: a real Winlink RF session over UZ7HO
// Soundmodem's native AGWPE port connected and exchanged real data for 8+
// seconds, then still hit startSession()'s own "no response" backstop —
// only possible if the AGWPE server's 'C' connected-notification didn't
// resolve to the SAME session object startSession() created, leaving that
// original session stuck in 'connecting' (its timer still armed) while a
// separate, wrongly-"unsolicited" session object handled the real
// exchange. Root cause is presumed to be UZ7HO echoing the target
// callsign back in a different string form than this app sent in its own
// 'C' request — can't be verified without UZ7HO's source (closed-source),
// so this simulates a plausible mismatch (a trailing marker character,
// like the "*" some AGWPE-family tools append to a callsign) against a
// custom fake server, rather than depending on knowing UZ7HO's exact
// behavior. TncManager.js's _resolveAgwpeSession() should adopt the one
// pending 'connecting' session on the radio instead of treating this as
// an unrelated unsolicited connection, and the original backstop timer
// should never fire once that happens.
const assert = require('assert');
const net = require('net');
const { HEADER_LEN, buildAgwFrame } = require('../electron/main/adapters/AgwpeAdapter');
const TncManager = require('../electron/main/tnc/TncManager');

// A fake AGWPE server that acks 'X', answers 'G', and on 'C' replies with
// the connected notification using a DELIBERATELY mismatched callTo (a
// trailing "*") — simulating a real server's formatting differing from
// what this app itself would produce. 'D' data just echoes back so a real
// exchange can be observed to actually work end-to-end despite the mismatch.
function startMismatchedAgwServer(port) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= HEADER_LEN) {
          const dataLen = buf.readUInt32LE(28);
          if (buf.length < HEADER_LEN + dataLen) break;
          const header = buf.slice(0, HEADER_LEN);
          const data = buf.slice(HEADER_LEN, HEADER_LEN + dataLen);
          buf = buf.slice(HEADER_LEN + dataLen);
          const dataKind = header.toString('ascii', 4, 5);
          const callFrom = header.toString('ascii', 8, 18).replace(/\0.*$/, '').trim();
          const callTo = header.toString('ascii', 18, 28).replace(/\0.*$/, '').trim();
          if (dataKind === 'G') {
            socket.write(buildAgwFrame({ dataKind: 'G', data: '1;Port1 Fake Radio Port;\0' }));
          } else if (dataKind === 'C') {
            // Real mismatch: echoes callTo with a trailing "*" this app never sent.
            socket.write(buildAgwFrame({ dataKind: 'C', callFrom, callTo: `${callTo}*`, data: `*** CONNECTED With ${callTo}*\r` }));
          } else if (dataKind === 'D') {
            // Echo real data back so the test can observe a genuine exchange,
            // still using the mismatched callTo form.
            socket.write(buildAgwFrame({ dataKind: 'D', callFrom, callTo: `${callTo}*`, data: Buffer.concat([Buffer.from('ECHO:'), data]) }));
          }
        }
      });
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

async function main() {
  const agwPort = 19700 + Math.floor(Math.random() * 1000);
  const server = await startMismatchedAgwServer(agwPort);

  // Fast, test-only backstop instead of the real 36s one.
  const mgr = new TncManager({ agwpeConnectTimeoutMs: 800 });
  const tnc = mgr.createTnc({ name: 'A', type: 'agwpe', connection: { host: '127.0.0.1', port: agwPort } });
  const radio = mgr.addRadio(tnc.id, { callsign: 'N0CALL-10', portNumber: 0 });
  mgr.connectTnc(tnc.id);
  await wait(150);

  const sessionStates = [];
  mgr.on('session-state', (s) => sessionStates.push(s));
  const sessionErrors = [];
  mgr.on('session-error', (e) => sessionErrors.push(e));
  const sessionData = [];
  mgr.on('session-data', (d) => sessionData.push(d));

  await test('a connected notification with a mismatched callsign format still resolves to the pending session, not a false give-up', async () => {
    const snap = mgr.startSession(tnc.id, radio.id, 'W1ABC-10');
    await wait(300);
    assert.ok(sessionStates.some((s) => s.id === snap.id && s.state === 'connected'), 'session should be marked connected despite the mismatched echo');
    // Wait past the (short, test-only) backstop window to prove it does NOT fire.
    await wait(1200);
    assert.strictEqual(sessionErrors.length, 0, `should not have given up — got: ${JSON.stringify(sessionErrors)}`);
    assert.strictEqual(mgr._findSession(snap.id).state, 'connected', 'session should still be connected after the backstop window passes');

    mgr.sendSessionText(snap.id, 'hello');
    await wait(300);
    assert.ok(sessionData.some((d) => d.text === 'ECHO:hello'), 'data should flow normally once resolved, even though the server keeps using its own mismatched callTo form');
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgr.shutdown();
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

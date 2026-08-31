#!/usr/bin/env node
// Reported live against a real LinBPQ node (WB4GBI-7): once the remote
// rejected a frame with REJ, NexPack never retransmitted anything — it just
// kept sending whatever the user typed next with an incrementing N(S),
// permanently desyncing the session until the remote gave up and sent DISC.
// Separately, the remote's periodic keep-alive poll (RR, Poll bit set) got
// no response at all until the eventual DISC — AX.25 requires an immediate
// reply to any frame with the Poll bit set.
//
// This drives a real TncManager against a real TCP "radio" bridge, with a
// scripted fake peer standing in for the remote station so each scenario
// (an explicit REJ, a Poll, a lost ack) can be forced deterministically
// rather than relying on another real AX.25 stack's own edge-case behavior.
const assert = require('assert');
const net = require('net');
const TncManager = require('../electron/main/tnc/TncManager');
const { parseAx25Frame, buildAx25Frame } = require('../electron/main/ax25/ax25');
const { escapeFrame, unescapeStream } = require('../electron/main/ax25/kiss');

const OUR_CALL = 'NA4WX-9';
const PEER_CALL = 'WB4GBI-7';

// A scripted stand-in for the remote station: auto-answers SABM with UA
// (so a real TncManager can connect to it normally), then hands every
// inbound AX.25 frame to onFrame() so the test controls exactly what (if
// anything) gets sent back — no automatic acking to race against.
function startFakePeer(port, onFrame) {
  return new Promise((resolve) => {
    let socket = null;
    const server = net.createServer((sock) => {
      socket = sock;
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (true) {
          const start = buf.indexOf(0xc0);
          if (start === -1) { buf = Buffer.alloc(0); break; }
          const end = buf.indexOf(0xc0, start + 1);
          if (end === -1) break;
          const kissFrame = buf.subarray(start, end + 1);
          buf = buf.subarray(end + 1);
          let ax25;
          try {
            const frames = unescapeStream(kissFrame);
            if (!frames.length) continue;
            ax25 = parseAx25Frame(frames[0].frame);
          } catch (e) { continue; }
          const isSabm = ax25.control === 0x2f || ax25.control === 0x3f;
          if (isSabm) {
            send(buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: 0x73, pid: null, payload: Buffer.alloc(0) }));
          } else if (onFrame) {
            onFrame(ax25);
          }
        }
      });
      sock.on('error', () => {});
    });
    function send(frame) {
      if (!socket || socket.destroyed) return;
      socket.write(escapeFrame(frame, 0));
    }
    server.listen(port, '127.0.0.1', () => resolve({ server, send }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function connectA(bridgePort, mgrOpts = {}) {
  const mgrA = new TncManager(mgrOpts);
  const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: OUR_CALL, portNumber: 0 });
  mgrA.connectTnc(tncA.id);
  await wait(150);
  const snap = mgrA.startSession(tncA.id, radioA.id, PEER_CALL);
  await wait(200);
  const session = Array.from(mgrA.sessions.values()).find((s) => s.id === snap.id);
  assert.ok(session && session.state === 'connected', 'setup: A should be connected');
  return { mgrA, sessionId: snap.id };
}

async function main() {
  let port = 20500 + Math.floor(Math.random() * 500);

  // --- 1: receiving an explicit REJ makes the sender retransmit its
  // outstanding frames, instead of ignoring it and moving on ---
  await test('a received REJ triggers retransmission of the outstanding frame(s)', async () => {
    const receivedIframes = [];
    const peer = await startFakePeer(port, (ax25) => {
      if ((ax25.control & 0x01) === 0) receivedIframes.push(ax25.payload.toString('utf8')); // I-frame, never acked on purpose
    });
    const { mgrA, sessionId } = await connectA(port, { iframeRetryMs: 100000, iframeRetryCount: 5 });

    mgrA.sendSessionText(sessionId, 'first'); // N(S)=0, never acked by the fake peer
    await wait(150);
    assert.deepStrictEqual(receivedIframes, ['first']);

    // Peer sends a real REJ(N(R)=0) — "I never got frame 0, send it again."
    const rejControl = (0 << 5) | (1 << 2) | 0x01; // REJ, N(R)=0
    peer.send(buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: rejControl, pid: null, payload: Buffer.alloc(0) }));
    await wait(200);

    assert.deepStrictEqual(receivedIframes, ['first', 'first'], `expected the sender to retransmit "first" after the REJ, got: ${JSON.stringify(receivedIframes)}`);

    mgrA.shutdown();
    peer.server.close();
  });

  // --- 2: a Poll gets an immediate response, not silence until DISC ---
  port += 1;
  await test('a supervisory frame with the Poll bit set gets an immediate response', async () => {
    let sawResponse = false;
    const peer = await startFakePeer(port, (ax25) => {
      const isSupervisory = (ax25.control & 0x03) === 0x01;
      if (isSupervisory) sawResponse = true;
    });
    const { mgrA, sessionId } = await connectA(port);

    // Peer sends a real poll (RR, Poll bit set) — exactly what a real node's
    // keep-alive check looks like on the wire.
    const pollControl = (0 << 5) | 0x10 | 0x01; // RR, N(R)=0, P=1
    peer.send(buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: pollControl, pid: null, payload: Buffer.alloc(0) }));
    await wait(200);

    assert.ok(sawResponse, 'the peer should have received an immediate supervisory reply to its poll');
    mgrA.shutdown();
    peer.server.close();
  });

  // --- 3: if even the REJ never arrives (ack lost entirely), a T1-style
  // timer notices the silence and retransmits on its own ---
  port += 1;
  await test('an outstanding frame that is never acked at all gets retransmitted once T1 expires', async () => {
    const receivedIframes = [];
    const peer = await startFakePeer(port, (ax25) => {
      if ((ax25.control & 0x01) === 0) receivedIframes.push(ax25.payload.toString('utf8')); // never acked, ever
    });
    const { mgrA, sessionId } = await connectA(port, { iframeRetryMs: 150, iframeRetryCount: 3 });

    mgrA.sendSessionText(sessionId, 'hello');
    await wait(50);
    assert.deepStrictEqual(receivedIframes, ['hello']);

    await wait(120); // past the first T1 interval (150ms), short of a second one
    assert.deepStrictEqual(receivedIframes, ['hello', 'hello'], 'T1 expiring with no ack at all should retransmit automatically');

    mgrA.shutdown();
    peer.server.close();
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

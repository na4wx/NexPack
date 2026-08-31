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

  // --- 4: the modulo-8 window caps outstanding frames instead of blowing
  // through it — a burst of sends (e.g. YAPP's chunk loop) must queue past
  // the window and only release more once acks arrive ---
  port += 1;
  await test('a burst of sends respects the outstanding-frame window instead of overrunning it', async () => {
    const receivedNs = [];
    const peer = await startFakePeer(port, (ax25) => {
      if ((ax25.control & 0x01) === 0) receivedNs.push((ax25.control >> 1) & 0x07); // never acked yet
    });
    const { mgrA, sessionId } = await connectA(port, { iframeRetryMs: 100000, iframeRetryCount: 5, maxOutstandingIframes: 3 });

    for (let i = 0; i < 8; i++) mgrA.sendSessionText(sessionId, `line${i}`);
    await wait(150);
    assert.deepStrictEqual(receivedNs, [0, 1, 2], `only the first 3 (the window) should have gone out, got N(S) list: ${JSON.stringify(receivedNs)}`);

    // Ack frames 0 and 1 (N(R)=2) — exactly 2 slots should open up.
    const rrControl = (2 << 5) | 0x01; // RR, N(R)=2
    peer.send(buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: rrControl, pid: null, payload: Buffer.alloc(0) }));
    await wait(150);
    assert.deepStrictEqual(receivedNs, [0, 1, 2, 3, 4], `acking 2 frames should release exactly 2 more from the queue, got: ${JSON.stringify(receivedNs)}`);

    mgrA.shutdown();
    peer.server.close();
  });

  // --- 5: RNR ("I'm busy") pauses sending until the peer clears it ---
  port += 1;
  await test('RNR pauses outbound frames until the peer sends RR/REJ again', async () => {
    const receivedIframes = [];
    const peer = await startFakePeer(port, (ax25) => {
      if ((ax25.control & 0x01) === 0) receivedIframes.push(ax25.payload.toString('utf8'));
    });
    const { mgrA, sessionId } = await connectA(port, { iframeRetryMs: 120, iframeRetryCount: 5 });

    mgrA.sendSessionText(sessionId, 'first');
    await wait(80);
    assert.deepStrictEqual(receivedIframes, ['first']);

    const rnrControl = (0 << 5) | (2 << 2) | 0x01; // RNR, N(R)=0
    peer.send(buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: rnrControl, pid: null, payload: Buffer.alloc(0) }));
    await wait(300); // well past iframeRetryMs — a non-RNR-aware sender would have retransmitted by now
    assert.deepStrictEqual(receivedIframes, ['first'], 'no retransmission should happen while the peer is RNR-busy');

    const rrControl = (0 << 5) | 0x01; // RR, N(R)=0 — "never mind, still expecting frame 0"
    peer.send(buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: rrControl, pid: null, payload: Buffer.alloc(0) }));
    await wait(200);
    assert.deepStrictEqual(receivedIframes, ['first', 'first'], 'clearing RNR should let the retry logic resume and retransmit the still-unacked frame');

    mgrA.shutdown();
    peer.server.close();
  });

  // --- 6: DM in reply to our SABM is a definitive refusal, not silence to
  // retry blindly for the full ~30s worst case ---
  port += 1;
  await test('DM in reply to SABM is reported as a clear refusal, not a generic timeout', async () => {
    const peer = await startFakePeer(port, () => {}); // never actually used — SABM handling below is custom
    // Override the peer's SABM auto-UA behavior for this one test: reject instead.
    peer.server.removeAllListeners('connection');

    const mgrA = new TncManager({ sabmRetryMs: 100000, sabmRetryCount: 5 });
    const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port } });
    const radioA = mgrA.addRadio(tncA.id, { callsign: OUR_CALL, portNumber: 0 });

    const net2 = require('net');
    const server2 = net2.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const start = buf.indexOf(0xc0);
        const end = buf.indexOf(0xc0, start + 1);
        if (start === -1 || end === -1) return;
        const dm = buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: 0x1f, pid: null, payload: Buffer.alloc(0) }); // DM, F=1
        sock.write(escapeFrame(dm, 0));
      });
    });
    peer.server.close();
    await new Promise((res) => server2.listen(port, '127.0.0.1', res));

    const errors = [];
    mgrA.on('session-error', (e) => errors.push(e));
    mgrA.connectTnc(tncA.id);
    await wait(150);
    mgrA.startSession(tncA.id, radioA.id, PEER_CALL);
    await wait(200);

    assert.strictEqual(errors.length, 1, `expected exactly one session-error from the DM refusal, got: ${JSON.stringify(errors)}`);
    assert.ok(/refused/i.test(errors[0].message), `expected a "refused" message, got: ${errors[0].message}`);
    assert.strictEqual(mgrA.sessions.size, 0, 'the refused session should not linger');

    mgrA.shutdown();
    server2.close();
  });

  // --- 7: DM while connected means the peer reset without a proper DISC —
  // we should notice and clean up, not sit "connected" forever ---
  port += 1;
  await test('an unexpected DM while connected tears the session down', async () => {
    const peer = await startFakePeer(port, () => {});
    const { mgrA, sessionId } = await connectA(port);

    const states = [];
    mgrA.on('session-state', (s) => { if (s.id === sessionId) states.push(s.state); });

    const dm = buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: 0x0f, pid: null, payload: Buffer.alloc(0) });
    peer.send(dm);
    await wait(150);

    assert.ok(states.includes('disconnected'), `expected the session to transition to disconnected after an unexpected DM, got states: ${JSON.stringify(states)}`);
    assert.strictEqual(mgrA.sessions.size, 0);

    mgrA.shutdown();
    peer.server.close();
  });

  // --- 8: an idle connected session polls the peer itself (T3), and gives
  // up if the peer never answers — not just silence forever ---
  port += 1;
  await test('an idle session polls the peer (T3) and reports lost contact if it never answers', async () => {
    const polls = [];
    const peer = await startFakePeer(port, (ax25) => {
      const isSupervisory = (ax25.control & 0x03) === 0x01;
      const pf = (ax25.control & 0x10) !== 0;
      if (isSupervisory && pf) polls.push(ax25); // never answered, on purpose
    });
    const { mgrA, sessionId } = await connectA(port, { t3IdleMs: 100, t3MissedPollLimit: 2 });

    const errors = [];
    mgrA.on('session-error', (e) => errors.push(e));

    await wait(100 * 5 + 200); // several T3 intervals
    assert.ok(polls.length >= 3, `expected multiple idle polls, got ${polls.length}`);
    assert.strictEqual(errors.length, 1, `expected exactly one "lost contact" error, got: ${JSON.stringify(errors)}`);
    assert.ok(/lost contact/i.test(errors[0].message));
    assert.strictEqual(mgrA.sessions.size, 0);

    mgrA.shutdown();
    peer.server.close();
  });

  // --- 9: a TNC disconnected out from under a live session (adapter goes
  // null) must not crash the process from inside a retry timer ---
  port += 1;
  await test('a TNC disconnected mid-session is handled cleanly by retry timers, not a crash', async () => {
    let crashed = null;
    const onUncaught = (err) => { crashed = err; };
    process.on('uncaughtException', onUncaught);

    const peer = await startFakePeer(port, () => {}); // never acks anything
    const { mgrA, sessionId } = await connectA(port, { iframeRetryMs: 100, iframeRetryCount: 2 });

    mgrA.sendSessionText(sessionId, 'orphaned');
    await wait(30);
    const tncA = Array.from(mgrA.tncs.keys())[0];
    mgrA.disconnectTnc(tncA); // adapter goes null while a frame is still outstanding

    const errors = [];
    mgrA.on('session-error', (e) => errors.push(e));
    await wait(300); // past the retry interval — this is where the old code would crash

    process.removeListener('uncaughtException', onUncaught);
    assert.ok(!crashed, `the process should not have crashed, but it did: ${crashed && crashed.stack}`);
    assert.ok(errors.some((e) => /disconnected/i.test(e.message)), `expected a clear "disconnected" session-error, got: ${JSON.stringify(errors)}`);

    mgrA.shutdown();
    peer.server.close();
  });

  // --- 10: frames that arrive out of send order (a real, normal RF
  // occurrence, not just loss) must still be DISPLAYED in the order they
  // were sent, not the order they happened to arrive ---
  port += 1;
  await test('I-frames that arrive out of order are resequenced before being delivered', async () => {
    const peer = await startFakePeer(port, () => {}); // acks/retries irrelevant to this test
    const { mgrA, sessionId } = await connectA(port);

    const received = [];
    mgrA.on('session-data', (d) => { if (d.sessionId === sessionId) received.push(d.text); });

    // Simulates exactly what was reported live: a multi-frame reply where
    // the tail (N(S)=2) physically arrives before the middle piece
    // (N(S)=1) — real RF reordering, not a dropped frame.
    const iframe = (ns, text) => buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: (0 << 5) | (ns << 1), pid: 0xf0, payload: Buffer.from(text, 'utf8') });
    peer.send(iframe(0, 'first '));
    await wait(30);
    peer.send(iframe(2, 'third ')); // out of order — arrives before N(S)=1
    await wait(30);
    peer.send(iframe(1, 'second ')); // fills the gap

    await wait(150);
    assert.deepStrictEqual(received, ['first ', 'second ', 'third '], `expected delivery in send order regardless of arrival order, got: ${JSON.stringify(received)}`);

    mgrA.shutdown();
    peer.server.close();
  });

  // --- 11: a peer that retransmits its entire reply (a full modulo-8 pass)
  // must not have that treated as brand-new data just because N(S) wraps
  // back to exactly what we expect next ---
  port += 1;
  await test('a full-window retransmission is recognized as a duplicate, not re-delivered as new data', async () => {
    const peer = await startFakePeer(port, () => {}); // never satisfied — retransmits regardless of our acks, on purpose
    const { mgrA, sessionId } = await connectA(port);

    const received = [];
    const acksSent = [];
    mgrA.on('session-data', (d) => { if (d.sessionId === sessionId) received.push(d.text); });
    mgrA.on('monitor', (e) => { if (e.direction === 'tx' && e.frameType === 'rr') acksSent.push(e.control); });

    const iframe = (ns, text) => buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: (0 << 5) | (ns << 1), pid: 0xf0, payload: Buffer.from(text, 'utf8') });
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']; // a full 8-frame pass, ns 0..7

    for (let ns = 0; ns < 8; ns++) { peer.send(iframe(ns, lines[ns])); await wait(10); }
    await wait(50);
    assert.deepStrictEqual(received, lines, 'the first pass should be delivered once, in order');

    // Confirmed live against a real node: it kept retransmitting its whole
    // reply — same content, same N(S) values, starting the cycle over.
    for (let ns = 0; ns < 8; ns++) { peer.send(iframe(ns, lines[ns])); await wait(10); }
    await wait(50);

    assert.deepStrictEqual(received, lines, `the retransmitted pass should NOT be delivered again, got: ${JSON.stringify(received)}`);

    mgrA.shutdown();
    peer.server.close();
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

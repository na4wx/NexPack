#!/usr/bin/env node
// Reported live against a real LinBPQ node: after connecting and getting the
// banner, every typed command (TNCHAT, BBS) got acked at the AX.25 layer
// (RR frames came back) but never got an application-level reply at all.
// Root cause: NexPack sent the raw typed text with no line terminator.
// Real packet BBS/node software buffers incoming bytes and only processes
// a command once it sees the CR a real terminal would send for Enter —
// without it, the remote just keeps waiting for more bytes that never
// arrive. This test stands in for exactly that: a fake peer that buffers
// I-frame payloads and only "responds" once it sees a CR.
const assert = require('assert');
const net = require('net');
const TncManager = require('../electron/main/tnc/TncManager');
const { parseAx25Frame, buildAx25Frame } = require('../electron/main/ax25/ax25');
const { escapeFrame, unescapeStream } = require('../electron/main/ax25/kiss');

const OUR_CALL = 'NA4WX-9';
const PEER_CALL = 'WB4GBI-7';

// A line-buffered fake peer: auto-answers SABM with UA, then accumulates
// I-frame payload bytes and only calls onLine() once a CR-terminated line
// is seen — exactly how a real terminal-oriented node/BBS behaves.
function startLineBufferedPeer(port, onLine) {
  return new Promise((resolve) => {
    let socket = null;
    let lineBuf = '';
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
          const isIframe = (ax25.control & 0x01) === 0;
          if (isSabm) {
            send(buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: 0x73, pid: null, payload: Buffer.alloc(0) }));
          } else if (isIframe) {
            const ns = (ax25.control >> 1) & 0x07;
            const rr = (ns + 1) << 5 | 0x01;
            send(buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: rr, pid: null, payload: Buffer.alloc(0) })); // link-layer ack, always
            lineBuf += ax25.payload.toString('utf8');
            const crIdx = lineBuf.indexOf('\r');
            if (crIdx !== -1) {
              const line = lineBuf.slice(0, crIdx);
              lineBuf = lineBuf.slice(crIdx + 1);
              if (onLine) onLine(line, (replyText) => {
                const replyPayload = Buffer.from(replyText, 'utf8');
                send(buildAx25Frame({ dest: OUR_CALL, src: PEER_CALL, control: 0x00, pid: 0xf0, payload: replyPayload }));
              });
            }
            // else: incomplete line, keep buffering — never replies, matching real linbpq behavior
          }
        }
      });
      sock.on('error', () => {});
    });
    function send(frame) {
      if (!socket || socket.destroyed) return;
      socket.write(escapeFrame(frame, 0));
    }
    server.listen(port, '127.0.0.1', () => resolve({ server }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (fn()) return true; await wait(30); }
  return false;
};

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const port = 20800 + Math.floor(Math.random() * 500);

  await test('an interactive Terminal command line is CR-terminated so a real line-buffered node actually responds', async () => {
    const linesSeen = [];
    const peer = await startLineBufferedPeer(port, (line, reply) => {
      linesSeen.push(line);
      if (line === 'BBS') reply('Connected to BBS\r');
    });

    const mgrA = new TncManager({});
    const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port } });
    const radioA = mgrA.addRadio(tncA.id, { callsign: OUR_CALL, portNumber: 0 });
    mgrA.connectTnc(tncA.id);
    await wait(150);
    const snap = mgrA.startSession(tncA.id, radioA.id, PEER_CALL);
    await wait(200);

    const dataA = [];
    mgrA.on('session-data', (d) => dataA.push(d.text));

    // This is the exact path the renderer's Terminal input box drives via
    // the terminal:sendSessionText IPC channel — CR-termination has to
    // happen for real typed commands, not just be available as an opt-in.
    mgrA.sendSessionLine(snap.id, 'BBS');
    const gotReply = await waitUntil(() => dataA.length > 0);

    assert.deepStrictEqual(linesSeen, ['BBS'], `the peer should have seen a complete, CR-terminated line, got: ${JSON.stringify(linesSeen)}`);
    assert.ok(gotReply, 'a real line-buffered peer should have replied once it saw the CR-terminated command');
    assert.ok(dataA.some((t) => t.includes('Connected to BBS')), `expected the BBS reply text, got: ${JSON.stringify(dataA)}`);

    mgrA.shutdown();
    peer.server.close();
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

#!/usr/bin/env node
// Real end-to-end test of InboundNodeServer: a real "visitor" TncManager
// connects over a real TCP KISS loopback to a "local" TncManager configured
// with three radios (Terminal-node/BBS/Chat identities) sharing one
// physical TNC port — exactly the setup the whole feature depends on.
// BBS commands are driven against a real local http.Server standing in for
// NexDigi's REST API; Chat is driven against a real local http+ws server
// standing in for NexDigi's chat WebSocket. No mocks of NexPack's own code.
const assert = require('assert');
const net = require('net');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const TncManager = require('../electron/main/tnc/TncManager');
const BbsFacade = require('../electron/main/bbs/BbsFacade');
const NexDigiClient = require('../electron/main/bbs/NexDigiClient');
const RfBbsClient = require('../electron/main/bbs/RfBbsClient');
const TerminalSettings = require('../electron/main/settings/TerminalSettings');
const InboundServerSettings = require('../electron/main/settings/InboundServerSettings');
const InboundNodeServer = require('../electron/main/tnc/InboundNodeServer');

const NODE_CALL = 'NA4WX-9';
const BBS_CALL = 'NA4WX-2';
const CHAT_CALL = 'NA4WX-3';
const REMOTE_CALL = 'K1ABC-5';

function startBridge(port) {
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

function startFakeBbsServer(port) {
  let nextId = 1;
  const messages = [];
  const bulletins = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const readMatch = /\/api\/bbs\/messages\/(\d+)\/read/.exec(req.url);
      const delMatch = /\/api\/bbs\/messages\/(\d+)$/.exec(req.url);
      if (req.method === 'GET' && req.url.startsWith('/api/bbs/messages')) {
        res.end(JSON.stringify(messages));
      } else if (req.method === 'GET' && req.url === '/api/bbs/bulletins') {
        res.end(JSON.stringify(bulletins));
      } else if (req.method === 'POST' && req.url === '/api/bbs/messages') {
        const json = body ? JSON.parse(body) : {};
        const m = { messageNumber: nextId++, read: false, timestamp: Date.now(), ...json };
        messages.push(m);
        res.end(JSON.stringify({ messageNumber: m.messageNumber }));
      } else if (req.method === 'PUT' && readMatch) {
        const n = Number(readMatch[1]);
        const m = messages.find((x) => x.messageNumber === n) || bulletins.find((x) => x.messageNumber === n);
        if (m) m.read = true;
        res.end(JSON.stringify({ success: true }));
      } else if (req.method === 'DELETE' && delMatch) {
        const n = Number(delMatch[1]);
        const idx = messages.findIndex((x) => x.messageNumber === n);
        if (idx !== -1) messages.splice(idx, 1);
        res.end(JSON.stringify({ success: true }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, messages, bulletins })));
}

function startFakeChatServer(port) {
  const state = { received: [] };
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('/history')) res.end(JSON.stringify({ messages: [] }));
      else if (req.url.includes('/users')) res.end(JSON.stringify({ users: [] }));
      else res.end(JSON.stringify({ success: true }));
    });
  });
  const wss = new WebSocket.Server({ server: httpServer });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (msg.type === 'chat-connect') {
        ws._callsign = msg.callsign;
        ws.send(JSON.stringify({ type: 'chat-connected' }));
        setTimeout(() => {
          try { ws.send(JSON.stringify({ type: 'chat-message', message: { from: 'OTHERUSER', text: 'welcome to lobby', timestamp: Date.now() } })); } catch (e) { /* ignore */ }
        }, 30);
      } else if (msg.type === 'chat-message') {
        state.received.push({ from: ws._callsign, text: msg.text });
      }
    });
  });
  return new Promise((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve({ httpServer, wss, state })));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, timeoutMs = 5000) => {
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
  const bridgePort = 21400 + Math.floor(Math.random() * 500);
  const bbsServerPort = bridgePort + 100;
  const chatServerPort = bridgePort + 101;
  const bridge = await startBridge(bridgePort);
  const bbsServer = await startFakeBbsServer(bbsServerPort);
  const chatServer = await startFakeChatServer(chatServerPort);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-inbound-node-test-'));

  // "Local" NexPack: one TNC, three radios (all port 0) — Terminal/BBS/Chat identities.
  const mgrLocal = new TncManager({});
  const tncLocal = mgrLocal.createTnc({ name: 'local', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const nodeRadio = mgrLocal.addRadio(tncLocal.id, { callsign: NODE_CALL, portNumber: 0 });
  const bbsRadio = mgrLocal.addRadio(tncLocal.id, { callsign: BBS_CALL, portNumber: 0 });
  const chatRadio = mgrLocal.addRadio(tncLocal.id, { callsign: CHAT_CALL, portNumber: 0 });
  mgrLocal.connectTnc(tncLocal.id);

  // "Remote": a plain visitor station.
  const mgrRemote = new TncManager({});
  const tncRemote = mgrRemote.createTnc({ name: 'remote', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const remoteRadio = mgrRemote.addRadio(tncRemote.id, { callsign: REMOTE_CALL, portNumber: 0 });
  mgrRemote.connectTnc(tncRemote.id);
  await wait(200);

  const terminalSettings = new TerminalSettings({ userDataDir: dir });
  terminalSettings.saveSettings({ defaultTncId: tncLocal.id, defaultRadioId: nodeRadio.id });

  const inboundServerSettings = new InboundServerSettings({ userDataDir: dir });
  inboundServerSettings.saveSettings({
    node: { enabled: true, preamble: 'Welcome to {callsign}!\nReply CHAT or BBS, or BYE to disconnect.' },
    bbs: { enabled: true, tncId: tncLocal.id, radioId: bbsRadio.id },
    chat: { enabled: true, tncId: tncLocal.id, radioId: chatRadio.id, defaultRoom: 'LOBBY' }
  });

  const nexDigiClient = new NexDigiClient({ userDataDir: dir });
  nexDigiClient.saveSettings({ host: `127.0.0.1:${bbsServerPort}`, password: 'x', callsign: 'LOCALOP' });
  // Chat's fake server runs on a different port — point a second settings
  // write there isn't possible (one shared host) so we point BOTH at the
  // chat server for the chat-mode tests and re-point for BBS-mode tests.
  const rfBbsClient = new RfBbsClient({ userDataDir: dir, tncManager: mgrLocal });
  const bbsFacade = new BbsFacade({ userDataDir: dir, nexDigiClient, rfBbsClient });

  const inboundNodeServer = new InboundNodeServer({ tncManager: mgrLocal, bbsFacade, nexDigiClient, terminalSettings, inboundServerSettings });

  // ---- helpers to drive the remote side ----
  function collectSession(sessionId) {
    const lines = [];
    let buffer = '';
    const listener = (evt) => {
      if (evt.sessionId !== sessionId) return;
      buffer += evt.text.replace(/\r\n?/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) { lines.push(buffer.slice(0, idx)); buffer = buffer.slice(idx + 1); }
    };
    mgrRemote.on('session-data', listener);
    return { lines, stop: () => mgrRemote.removeListener('session-data', listener) };
  }

  await test('connecting to a totally unconfigured SSID on the shared port gets no response (dispatch fix)', async () => {
    const snap = mgrRemote.startSession(tncRemote.id, remoteRadio.id, 'NA4WX-7'); // never configured
    const connected = await waitUntil(() => {
      const s = Array.from(mgrRemote.sessions.values()).find((x) => x.id === snap.id);
      return s && s.state === 'connected';
    }, 1000);
    assert.ok(!connected, 'an unconfigured SSID sharing the port must not be silently answered by another radio');
    mgrRemote.endSession(snap.id);
    await wait(100);
  });

  await test('node menu: connecting to the Terminal identity gets the preamble, replying BBS enters BBS mode', async () => {
    const snap = mgrRemote.startSession(tncRemote.id, remoteRadio.id, NODE_CALL);
    const collector = collectSession(snap.id); // attach before waiting — the preamble can arrive in the same tick as "connected"
    await waitUntil(() => Array.from(mgrRemote.sessions.values()).some((s) => s.id === snap.id && s.state === 'connected'));
    await waitUntil(() => collector.lines.length >= 2, 2000);
    assert.ok(collector.lines.some((l) => l.includes(REMOTE_CALL)), `preamble should include the connecting callsign, got: ${JSON.stringify(collector.lines)}`);
    assert.ok(collector.lines.some((l) => /CHAT or BBS/i.test(l)));

    collector.lines.length = 0;
    mgrRemote.sendSessionLine(snap.id, 'BBS');
    const gotPrompt = await waitUntil(() => collector.lines.some((l) => l.includes('CMD (H = Help)')), 3000);
    assert.ok(gotPrompt, `expected the BBS prompt after replying BBS, got: ${JSON.stringify(collector.lines)}`);

    collector.stop();
    mgrRemote.endSession(snap.id);
    await wait(150);
  });

  await test('direct connect to the BBS identity skips the menu entirely', async () => {
    const snap = mgrRemote.startSession(tncRemote.id, remoteRadio.id, BBS_CALL);
    const collector = collectSession(snap.id);
    await waitUntil(() => Array.from(mgrRemote.sessions.values()).some((s) => s.id === snap.id && s.state === 'connected'));
    const gotPrompt = await waitUntil(() => collector.lines.some((l) => l.includes('CMD (H = Help)')), 2000);
    assert.ok(gotPrompt, `expected the BBS prompt immediately, no preamble, got: ${JSON.stringify(collector.lines)}`);
    assert.ok(!collector.lines.some((l) => /Welcome/i.test(l)), 'a direct BBS connection should never show the node preamble');
    collector.stop();
    mgrRemote.endSession(snap.id);
    await wait(150);
  });

  await test('BBS command set: L, P, M call, R n, D — against the real fake BBS server', async () => {
    bbsServer.bulletins.push({ messageNumber: 100, sender: 'SYSOP', subject: 'Welcome', content: 'Hello all', timestamp: Date.now(), category: 'B' });

    const snap = mgrRemote.startSession(tncRemote.id, remoteRadio.id, BBS_CALL);
    const collector = collectSession(snap.id);
    await waitUntil(() => Array.from(mgrRemote.sessions.values()).some((s) => s.id === snap.id && s.state === 'connected'));
    const gotInitialPrompt = await waitUntil(() => collector.lines.some((l) => l.includes('CMD')), 2000);
    assert.ok(gotInitialPrompt, 'expected the BBS prompt on connect');

    collector.lines.length = 0;
    mgrRemote.sendSessionLine(snap.id, 'L');
    await waitUntil(() => collector.lines.some((l) => l.includes('Welcome')), 2000);
    assert.ok(collector.lines.some((l) => /^100: From SYSOP/.test(l)), `expected the bulletin listed, got: ${JSON.stringify(collector.lines)}`);

    // Post a message to the remote's own callsign, then list/read it as "personal".
    collector.lines.length = 0;
    mgrRemote.sendSessionLine(snap.id, `M ${REMOTE_CALL}`);
    await waitUntil(() => collector.lines.some((l) => /Enter message/.test(l)), 2000);
    mgrRemote.sendSessionLine(snap.id, 'Hello from the BBS test');
    mgrRemote.sendSessionLine(snap.id, '.');
    await waitUntil(() => collector.lines.some((l) => /Message sent/.test(l)), 2000);

    const posted = bbsServer.messages.find((m) => m.recipient === REMOTE_CALL);
    assert.ok(posted, 'the message should have actually been posted to the real fake BBS store');
    assert.strictEqual(posted.sender, REMOTE_CALL, `expected the message attributed to the remote visitor's own callsign, got: ${posted.sender}`);

    collector.lines.length = 0;
    mgrRemote.sendSessionLine(snap.id, 'P');
    await waitUntil(() => collector.lines.some((l) => l.includes('Hello from the BBS test') || /From K1ABC-5/.test(l)), 2000);
    const listLine = collector.lines.find((l) => /^\d+: From /.test(l));
    assert.ok(listLine, `expected a personal message list line, got: ${JSON.stringify(collector.lines)}`);
    const n = Number(listLine.split(':')[0]);

    collector.lines.length = 0;
    mgrRemote.sendSessionLine(snap.id, `R ${n}`);
    await waitUntil(() => collector.lines.some((l) => l.includes('Hello from the BBS test')), 2000);
    assert.ok(collector.lines.some((l) => l.startsWith('From:')));

    collector.lines.length = 0;
    mgrRemote.sendSessionLine(snap.id, 'D');
    await waitUntil(() => collector.lines.some((l) => /deleted/.test(l)), 2000);
    assert.ok(!bbsServer.messages.some((m) => m.messageNumber === n), 'the message should be gone from the real fake BBS store after delete');

    collector.stop();
    mgrRemote.endSession(snap.id);
    await wait(150);
  });

  await test('Chat mode: direct connect joins immediately, both directions relay for real', async () => {
    // Re-point the shared NexDigi connection at the chat fake server for this test.
    nexDigiClient.saveSettings({ host: `127.0.0.1:${chatServerPort}`, password: 'x' });

    const snap = mgrRemote.startSession(tncRemote.id, remoteRadio.id, CHAT_CALL);
    const collector = collectSession(snap.id);
    await waitUntil(() => Array.from(mgrRemote.sessions.values()).some((s) => s.id === snap.id && s.state === 'connected'));
    assert.ok(!(await waitUntil(() => collector.lines.some((l) => /CMD \(H/.test(l)), 300)), 'a direct Chat connection should never show the BBS prompt');

    const joined = await waitUntil(() => collector.lines.some((l) => /Joined LOBBY/.test(l)), 2000);
    assert.ok(joined, `expected a join confirmation, got: ${JSON.stringify(collector.lines)}`);

    const gotBroadcast = await waitUntil(() => collector.lines.some((l) => l.includes('OTHERUSER: welcome to lobby')), 2000);
    assert.ok(gotBroadcast, `a message from another chat user should relay over RF, got: ${JSON.stringify(collector.lines)}`);

    mgrRemote.sendSessionLine(snap.id, 'hello from RF');
    const gotIt = await waitUntil(() => chatServer.state.received.some((m) => m.text === 'hello from RF'), 2000);
    assert.ok(gotIt, 'the remote visitor\'s typed line should reach the real fake chat server');
    const received = chatServer.state.received.find((m) => m.text === 'hello from RF');
    assert.strictEqual(received.from, REMOTE_CALL, `expected the message attributed to the visitor's own callsign, got: ${received.from}`);

    collector.lines.length = 0;
    mgrRemote.sendSessionLine(snap.id, 'BYE');
    const disconnected = await waitUntil(() => {
      const s = Array.from(mgrRemote.sessions.values()).find((x) => x.id === snap.id);
      return !s; // ended sessions are removed from the map
    }, 2000);
    assert.ok(disconnected, 'BYE should disconnect the AX.25 session from chat mode');

    collector.stop();
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgrLocal.shutdown();
  mgrRemote.shutdown();
  bridge.close();
  bbsServer.server.close();
  chatServer.httpServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

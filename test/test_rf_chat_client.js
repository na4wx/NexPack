#!/usr/bin/env node
// Real end-to-end test of RfChatClient against NexDigi's ACTUAL server-side
// BBS+Chat stack (not a fake/mock) — the real ChannelManager, the real
// KISS-TCP adapter, the real BBS, the real ChatManager, and the real
// BBSSessionManager text protocol (which is what actually routes "CHAT" ->
// ChatSession per server/TASK_6_RF_CHAT_COMPLETE.md), cross-required by
// relative path from the sibling NexDigi repo — same proven pattern as
// test_rf_bbs_client.js, extended with the chatManager param BBSSessionManager
// takes to enable RF chat routing (left null in the BBS-only test).
const assert = require('assert');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TncManager = require('../electron/main/tnc/TncManager');
const RfBbsClient = require('../electron/main/bbs/RfBbsClient');
const RfChatClient = require('../electron/main/chat/RfChatClient');

const NEXDIGI_LIB = path.join(__dirname, '..', '..', 'NexDigi', 'server', 'lib');
if (!fs.existsSync(NEXDIGI_LIB)) {
  console.log(`SKIP: sibling NexDigi repo not found at ${NEXDIGI_LIB} — this test requires it checked out alongside NexPack.`);
  process.exit(0);
}
const ChannelManager = require(path.join(NEXDIGI_LIB, 'channelManager'));
const SoundModemAdapter = require(path.join(NEXDIGI_LIB, 'adapters', 'soundmodemAdapter'));
const BBS = require(path.join(NEXDIGI_LIB, 'bbs'));
const BBSSessionManager = require(path.join(NEXDIGI_LIB, 'bbsSession'));
const ChatManager = require(path.join(NEXDIGI_LIB, 'chatManager'));

const BBS_CALLSIGN = 'NA4WX-7';
const CLIENT_CALLSIGN = 'N0CALL-9';

function startBridge(port) {
  return new Promise((resolve) => {
    const clients = [];
    const server = net.createServer((socket) => {
      clients.push(socket);
      socket.on('data', (data) => { for (const o of clients) if (o !== socket && !o.destroyed) o.write(data); });
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
  const bridgePort = 20200 + Math.floor(Math.random() * 1000);
  const bridge = await startBridge(bridgePort);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-rfchat-test-'));

  // ---- station A: NexPack client under test ----
  const mgrA = new TncManager({});
  const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: CLIENT_CALLSIGN, portNumber: 0 });
  mgrA.connectTnc(tncA.id);

  const rfBbsUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-rfchat-client-'));
  const rfBbsClient = new RfBbsClient({ userDataDir: rfBbsUserDataDir, tncManager: mgrA });
  rfBbsClient.saveSettings({ tncId: tncA.id, radioId: radioA.id, bbsCallsign: BBS_CALLSIGN, digiPath: [] });
  const client = new RfChatClient({ tncManager: mgrA, rfBbsClient });
  const events = [];
  client.on('chat-event', (e) => events.push(e));
  client.on('chat-error', (e) => events.push({ type: 'chat-error', ...e }));

  // ---- station B: NexDigi's REAL server-side BBS + Chat stack ----
  const bbsJsonPath = path.join(scratchDir, 'bbs.json');
  const bbsUsersPath = path.join(scratchDir, 'bbsUsers.json');
  fs.writeFileSync(bbsUsersPath, JSON.stringify({ users: { [CLIENT_CALLSIGN]: { name: 'Test User', qth: 'Test City, TS', lastSeen: null, connectCount: 0 } } }, null, 2));

  const bbs = new BBS(bbsJsonPath);
  const manager = new ChannelManager();
  const adapter = new SoundModemAdapter({ protocol: 'kiss-tcp', host: '127.0.0.1', port: bridgePort });
  manager.addChannel({ id: 'ch0', name: 'test', adapter, options: {} });
  const chatManager = new ChatManager(manager, { defaultRoom: 'LOBBY' });
  // 7th param is chatManager — TASK_6_RF_CHAT_COMPLETE.md documents this as
  // what wires "CHAT" in BBS mode to a real ChatSession.
  const bbsSessionManager = new BBSSessionManager(manager, BBS_CALLSIGN, bbsUsersPath, { allowedChannels: [], frameDelayMs: 0 }, bbs, null, chatManager);
  manager.on('frame', (event) => {
    try { bbsSessionManager.onFrame(Buffer.from(event.raw, 'hex'), event.channel); } catch (e) { console.error('bbsSessionManager.onFrame error', e); }
  });

  await wait(300); // let both KISS-TCP sockets settle

  await test('connect() reaches real chat mode over a real AX.25 session and auto-joins the default room', async () => {
    await client.connect();
    assert.strictEqual(client.connected, true);
    assert.strictEqual(client.currentRoom, 'LOBBY', `expected auto-joined LOBBY, got ${client.currentRoom}`);
    const connectedEvt = events.find((e) => e.type === 'chat-connected');
    assert.ok(connectedEvt, `expected a chat-connected event, got: ${JSON.stringify(events)}`);
  });

  await test('sendMessage() broadcasts to the real room and comes back to us as a real chat-message event', async () => {
    events.length = 0;
    client.sendMessage('hello from RF');
    await wait(500);
    const msg = events.find((e) => e.type === 'chat-message' && e.message && e.message.text === 'hello from RF');
    assert.ok(msg, `expected our own broadcast message to come back over RF, got: ${JSON.stringify(events)}`);
    assert.strictEqual(msg.message.from, CLIENT_CALLSIGN);
    assert.strictEqual(msg.roomName, 'LOBBY');
  });

  await test('a message from another (simulated web) user in the same room arrives as a real chat-message event', async () => {
    events.length = 0;
    chatManager.joinRoom('K4WEB', 'LOBBY'); // simulates a real web user joining, same as a real ChatSession would on connect
    chatManager.sendMessage('K4WEB', 'LOBBY', 'hello from the web');
    await wait(500);
    const msg = events.find((e) => e.type === 'chat-message' && e.message && e.message.text === 'hello from the web');
    assert.ok(msg, `expected the web user's message to reach us over RF, got: ${JSON.stringify(events)}`);
    assert.strictEqual(msg.message.from, 'K4WEB');
  });

  await test('listRooms() parses the real room list from a real /list reply', async () => {
    chatManager.createRoom('OFFTOPIC', { description: 'random chatter', creator: 'K4WEB' });
    const rooms = await client.listRooms();
    assert.ok(rooms.find((r) => r.name === 'LOBBY'), `expected LOBBY in ${JSON.stringify(rooms)}`);
    assert.ok(rooms.find((r) => r.name === 'OFFTOPIC'), `expected OFFTOPIC in ${JSON.stringify(rooms)}`);
  });

  await test('switchRoom() really joins a different real room and updates currentRoom', async () => {
    const result = await client.switchRoom('OFFTOPIC');
    assert.strictEqual(result.room, 'OFFTOPIC');
    assert.strictEqual(client.currentRoom, 'OFFTOPIC');
    assert.strictEqual(chatManager.getUserRoom(CLIENT_CALLSIGN), 'OFFTOPIC', 'the real ChatManager should also show us in OFFTOPIC now');
    assert.ok(result.users.some((u) => u.callsign === CLIENT_CALLSIGN), `expected the real /users reply to include ourselves, got: ${JSON.stringify(result.users)}`);
  });

  await test('a private message from another user arrives as a real chat-private-message event', async () => {
    events.length = 0;
    chatManager.sendPrivateMessage('K4WEB', CLIENT_CALLSIGN, 'psst, over here');
    await wait(500);
    const pm = events.find((e) => e.type === 'chat-private-message');
    assert.ok(pm, `expected a private message event, got: ${JSON.stringify(events)}`);
    assert.strictEqual(pm.message.from, 'K4WEB');
    assert.strictEqual(pm.message.text, 'psst, over here');
  });

  await test('disconnect() cleanly ends the real AX.25 session', async () => {
    client.disconnect();
    await wait(300);
    assert.strictEqual(client.connected, false);
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgrA.shutdown();
  bridge.close();
  fs.rmSync(rfBbsUserDataDir, { recursive: true, force: true });
  fs.rmSync(scratchDir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

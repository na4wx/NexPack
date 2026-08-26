#!/usr/bin/env node
// Real end-to-end test of ChatManager against a live NexDigi dev server
// (must be running on localhost:3010 — same bar as the BBS/Winlink tests:
// no mocks). Verifies the actual wire behavior discovered while building
// this: NexDigi's WS `chat-broadcast` wrapper type never really arrives
// (the inner event's own `type` field silently overwrites it via object
// spread), and that switching rooms via REST leave/join actually moves
// where a subsequently-sent WS message lands, rather than just updating
// local UI state.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const ChatManager = require('../electron/main/chat/ChatManager');
const NexDigiClient = require('../electron/main/bbs/NexDigiClient');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${e.stack || e.message}`); fail++; }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-chat-test-'));
  const client = new NexDigiClient({ userDataDir: dir });
  client.saveSettings({ host: 'localhost:3010', password: 'password1234', callsign: 'N0CALL' });
  const chat = new ChatManager({ nexDigiClient: client });
  const events = [];
  chat.on('chat-event', (m) => events.push(m));

  await test('connect() reaches the real server and receives chat-connected', async () => {
    chat.connect();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !events.find((e) => e.type === 'chat-connected')) await wait(100);
    const connected = events.find((e) => e.type === 'chat-connected');
    assert.ok(connected, 'should have received a real chat-connected event');
    assert.strictEqual(connected.callsign, 'N0CALL');
  });

  let roomName;
  await test('listRooms() returns a real unwrapped array (not the {success,rooms} envelope)', async () => {
    const rooms = await chat.listRooms();
    assert.ok(Array.isArray(rooms), 'listRooms should return a plain array');
    assert.ok(rooms.length > 0, 'the real server should have at least LOBBY');
    roomName = rooms[0].name;
  });

  await test('switchRoom() joins for real and returns real history/users arrays', async () => {
    const result = await chat.switchRoom(roomName);
    assert.strictEqual(chat.currentRoom, roomName);
    assert.ok(Array.isArray(result.history), 'history should be a plain array');
    assert.ok(Array.isArray(result.users), 'users should be a plain array');
  });

  await test('sendMessage() is received back over the real WebSocket as a chat-message event with the real roomName', async () => {
    const text = `NexPack automated test ${Date.now()}`;
    chat.sendMessage(text);
    const deadline = Date.now() + 3000;
    let echoed;
    while (Date.now() < deadline && !echoed) {
      echoed = events.find((e) => e.type === 'chat-message' && e.roomName === roomName && e.message && e.message.text === text);
      if (!echoed) await wait(100);
    }
    assert.ok(echoed, 'should receive the sent message back as a real broadcast');
  });

  await test('switching rooms actually moves the server-tracked current room, not just local UI state', async () => {
    await chat.createRoom('NEXPACKTEST', 'automated test room').catch(() => {}); // fine if it already exists
    await chat.switchRoom('NEXPACKTEST');
    assert.strictEqual(chat.currentRoom, 'NEXPACKTEST');

    const text = `second-room test ${Date.now()}`;
    chat.sendMessage(text);
    const deadline = Date.now() + 3000;
    let echoed;
    while (Date.now() < deadline && !echoed) {
      echoed = events.find((e) => e.type === 'chat-message' && e.message && e.message.text === text);
      if (!echoed) await wait(100);
    }
    assert.ok(echoed, 'should receive the message back');
    assert.strictEqual(echoed.roomName, 'NEXPACKTEST', 'message must land in the NEW room, not the old one');
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);
  chat.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

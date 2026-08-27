#!/usr/bin/env node
// Real end-to-end test of RfBbsClient against NexDigi's ACTUAL server-side
// BBS code (not a fake/mock) — the real ChannelManager, the real KISS-TCP
// adapter, the real BBS message store, and the real BBSSessionManager text
// protocol, cross-required by relative path from the sibling NexDigi repo,
// wired together exactly as server/index.js does in production. Only the
// transport is a loopback TCP bridge instead of real RF hardware.
const assert = require('assert');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TncManager = require('../electron/main/tnc/TncManager');
const RfBbsClient = require('../electron/main/bbs/RfBbsClient');

const NEXDIGI_LIB = path.join(__dirname, '..', '..', 'NexDigi', 'server', 'lib');
if (!fs.existsSync(NEXDIGI_LIB)) {
  console.log(`SKIP: sibling NexDigi repo not found at ${NEXDIGI_LIB} — this test requires it checked out alongside NexPack.`);
  process.exit(0);
}
const ChannelManager = require(path.join(NEXDIGI_LIB, 'channelManager'));
const SoundModemAdapter = require(path.join(NEXDIGI_LIB, 'adapters', 'soundmodemAdapter'));
const BBS = require(path.join(NEXDIGI_LIB, 'bbs'));
const BBSSessionManager = require(path.join(NEXDIGI_LIB, 'bbsSession'));

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
  const bridgePort = 20100 + Math.floor(Math.random() * 1000);
  const bridge = await startBridge(bridgePort);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-rfbbs-test-'));

  // ---- station A: NexPack client under test ----
  const mgrA = new TncManager({});
  const tncA = mgrA.createTnc({ name: 'A', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
  const radioA = mgrA.addRadio(tncA.id, { callsign: CLIENT_CALLSIGN, portNumber: 0 });
  mgrA.connectTnc(tncA.id);

  const rfBbsUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-rfbbs-client-'));
  const client = new RfBbsClient({ userDataDir: rfBbsUserDataDir, tncManager: mgrA });
  client.saveSettings({ tncId: tncA.id, radioId: radioA.id, bbsCallsign: BBS_CALLSIGN, digiPath: [] });

  // ---- station B: NexDigi's REAL server-side BBS stack ----
  const bbsJsonPath = path.join(scratchDir, 'bbs.json');
  const bbsUsersPath = path.join(scratchDir, 'bbsUsers.json');
  fs.writeFileSync(bbsUsersPath, JSON.stringify({ users: { [CLIENT_CALLSIGN]: { name: 'Test User', qth: 'Test City, TS', lastSeen: null, connectCount: 0 } } }, null, 2));

  const bbs = new BBS(bbsJsonPath);
  const seededBulletins = [
    bbs.addMessage('KJ4ABC', 'ALL', 'Repeater outage this weekend', { category: 'B', subject: 'Outage notice' }),
    bbs.addMessage('W1XYZ', 'ALL', 'Net starts at 7pm local', { category: 'B', subject: 'Weekly net' })
  ];
  const unreadMsg = bbs.addMessage('KJ4ABC', CLIENT_CALLSIGN, 'Hey, welcome to the BBS!', { category: 'P', subject: 'Welcome' });
  const preReadMsg = bbs.addMessage('W1XYZ', CLIENT_CALLSIGN, 'Already seen this one', { category: 'P', subject: 'Old news' });
  bbs.markAsRead(preReadMsg.messageNumber, CLIENT_CALLSIGN);

  const manager = new ChannelManager();
  const adapter = new SoundModemAdapter({ protocol: 'kiss-tcp', host: '127.0.0.1', port: bridgePort });
  manager.addChannel({ id: 'ch0', name: 'test', adapter, options: {} });
  const bbsSessionManager = new BBSSessionManager(manager, BBS_CALLSIGN, bbsUsersPath, { allowedChannels: [], frameDelayMs: 0 }, bbs, null, null);
  manager.on('frame', (event) => {
    try { bbsSessionManager.onFrame(Buffer.from(event.raw, 'hex'), event.channel); } catch (e) { console.error('bbsSessionManager.onFrame error', e); }
  });

  await wait(300); // let both KISS-TCP sockets settle

  await test('listBulletins() returns the real seeded bulletins from the real BBS', async () => {
    const bulletins = await client.listBulletins();
    assert.strictEqual(bulletins.length, 2, `expected 2 bulletins, got ${JSON.stringify(bulletins)}`);
    const first = bulletins.find((b) => b.messageNumber === seededBulletins[0].messageNumber);
    assert.ok(first, 'should find the first seeded bulletin by messageNumber');
    assert.strictEqual(first.sender, 'KJ4ABC');
    assert.strictEqual(first.subject, 'Outage notice');
    assert.strictEqual(first.category, 'B');
  });

  await test('listMessages() returns the real seeded personal messages, including read status', async () => {
    const messages = await client.listMessages({});
    assert.strictEqual(messages.length, 2, `expected 2 personal messages, got ${JSON.stringify(messages)}`);
    const unread = messages.find((m) => m.messageNumber === unreadMsg.messageNumber);
    const read = messages.find((m) => m.messageNumber === preReadMsg.messageNumber);
    assert.ok(unread && !unread.read, 'the unread message should show read:false');
    assert.ok(read && read.read, 'the pre-read message should show read:true');
    assert.strictEqual(unread.sender, 'KJ4ABC');
    assert.strictEqual(unread.subject, 'Welcome');
  });

  await test('markRead() fetches the real full content and marks it read server-side', async () => {
    const full = await client.markRead(unreadMsg.messageNumber);
    assert.strictEqual(full.messageNumber, unreadMsg.messageNumber);
    assert.strictEqual(full.sender, 'KJ4ABC');
    assert.strictEqual(full.subject, 'Welcome');
    assert.strictEqual(full.content, 'Hey, welcome to the BBS!');
    // confirm the REAL server-side store now shows it read
    const serverSide = bbs.getMessages({ messageNumber: unreadMsg.messageNumber })[0];
    assert.ok(serverSide.read, 'the real BBS store should show the message as read after markRead()');
  });

  let sentMessageNumber;
  await test('postMessage() creates a real message in the real BBS store', async () => {
    const result = await client.postMessage({ recipient: 'W1XYZ', content: 'Hello from RF!\r\nSecond line.' });
    assert.ok(result.messageNumber, 'should have parsed an assigned message number');
    sentMessageNumber = result.messageNumber;
    const serverSide = bbs.getMessages({ messageNumber: sentMessageNumber })[0];
    assert.ok(serverSide, 'the real BBS store should have the new message');
    assert.strictEqual(serverSide.sender, CLIENT_CALLSIGN);
    assert.strictEqual(serverSide.recipient, 'W1XYZ');
    assert.ok(serverSide.content.includes('Hello from RF!'), 'content should include the first line');
    assert.ok(serverSide.content.includes('Second line.'), 'content should include the second line');
    assert.strictEqual(serverSide.subject, 'BBS Message');
  });

  await test('deleteMessage() removes the real message from the real BBS store', async () => {
    await client.deleteMessage(sentMessageNumber);
    const stillThere = bbs.getMessages({ messageNumber: sentMessageNumber });
    assert.strictEqual(stillThere.length, 0, 'the message should be gone from the real store after delete');
  });

  await test('concurrent listBulletins()+listMessages() do not collide (mutex regression test)', async () => {
    const [bulletins, messages] = await Promise.all([client.listBulletins(), client.listMessages({})]);
    assert.strictEqual(bulletins.length, 2);
    assert.ok(bulletins.every((b) => b.category === 'B'), 'bulletins result should not be contaminated with personal messages');
    assert.ok(messages.every((m) => m.category === 'P'), 'messages result should not be contaminated with bulletins');
  });

  await test('an unonboarded callsign gets a clear error instead of hanging or corrupting the account', async () => {
    const otherUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpack-rfbbs-client2-'));
    const mgrC = new TncManager({});
    const tncC = mgrC.createTnc({ name: 'C', type: 'kiss-tcp', connection: { host: '127.0.0.1', port: bridgePort } });
    const radioC = mgrC.addRadio(tncC.id, { callsign: 'NEWGUY-1', portNumber: 0 });
    mgrC.connectTnc(tncC.id);
    await wait(200);
    const client2 = new RfBbsClient({ userDataDir: otherUserDataDir, tncManager: mgrC });
    client2.saveSettings({ tncId: tncC.id, radioId: radioC.id, bbsCallsign: BBS_CALLSIGN, digiPath: [] });
    await assert.rejects(() => client2.listBulletins(), /account|name|QTH/i, 'should reject with an onboarding-related error, not hang');
    mgrC.shutdown();
    fs.rmSync(otherUserDataDir, { recursive: true, force: true });
  });

  console.log(`\nTests passed: ${pass}`);
  console.log(`Tests failed: ${fail}`);

  mgrA.shutdown();
  try { adapter.socket && adapter.socket.destroy(); } catch (e) { /* ignore */ }
  bridge.close();
  fs.rmSync(scratchDir, { recursive: true, force: true });
  fs.rmSync(rfBbsUserDataDir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

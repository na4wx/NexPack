const EventEmitter = require('events');
const WebSocket = require('ws');

// Real network client to a running NexDigi server's Chat feature
// (server/routes/chat.js + the shared WebSocket in server/index.js).
// Unlike Winlink, chat genuinely lives on the digipeater - NexPack is a
// pure client here, the same way BBS is. Reuses the SAME NexDigiClient
// (host/password) as BBS rather than asking the user to configure the same
// server connection twice — but Chat's own callsign (chatCallsign, see
// _chatCallsign() below) is deliberately independent of BBS's, since
// there's no real reason those two identities need to match.
//
// Real API nuance (verified against current NexDigi source, not assumed):
// `chat-message` sends carry no room - the server tracks a per-callsign
// "current room" itself, set via the REST join/leave calls. So switching
// rooms here means: REST leave old room -> REST join new room -> THEN sent
// WS messages land in the new room. Incoming `chat-broadcast` events DO
// carry `roomName`, so the UI can still filter/group by room correctly.
class ChatManager extends EventEmitter {
  constructor({ nexDigiClient }) {
    super();
    this.nexDigiClient = nexDigiClient;
    this.ws = null;
    this.connected = false;
    this.currentRoom = null;
    this._closed = true;
    this._reconnectTimer = null;
  }

  _settings() {
    const s = this.nexDigiClient.getSettings();
    if (!s || !s.host) throw new Error('NexDigi server not configured');
    return s;
  }

  // Chat has its own identity (chatCallsign) distinct from BBS's callsign —
  // sharing one callsign for both was never a real requirement, just an
  // accident of them sharing the same server-connection storage. Falls
  // back to the BBS callsign only for settings saved before this existed.
  _chatCallsign(s) {
    return (s.chatCallsign || s.callsign || '').toUpperCase();
  }

  connect() {
    if (this.ws) return;
    this._closed = false;
    const s = this._settings();
    const wsProtocol = (s.protocol || 'http') === 'https' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${wsProtocol}://${s.host}?password=${encodeURIComponent(s.password || '')}`);

    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({ type: 'chat-connect', callsign: this._chatCallsign(s) }));
    });
    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (msg.type === 'chat-connected') this.connected = true;
      if (msg.type === 'chat-disconnected') this.connected = false;
      // NexDigi's server has a real quirk worth building against rather
      // than copying: `ws.send(JSON.stringify({ type: 'chat-broadcast',
      // ...data }))` where `data` already carries its own `type` field
      // (e.g. 'user-joined', 'topic-changed') means that inner type
      // silently overwrites the outer one — the wire message is NEVER
      // actually 'chat-broadcast', it's whatever the inner event type was.
      // Emitting one generic event with the raw message (instead of
      // dispatching on a fixed list of expected top-level types) means
      // NexPack surfaces every event type the server actually sends,
      // rather than silently dropping ones nobody enumerated in advance —
      // which is exactly the bug this quirk causes in NexDigi's own web
      // client (join/leave/topic/mute notifications never display there).
      this.emit('chat-event', msg);
    });
    this.ws.on('error', (err) => this.emit('chat-error', { message: err.message }));
    this.ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      this.emit('chat-socket-closed');
      if (!this._closed) this._reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
  }

  disconnect() {
    this._closed = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } this.ws = null; }
    this.connected = false;
    this.currentRoom = null;
  }

  async _request(method, urlPath, { json } = {}) {
    return this.nexDigiClient._request(method, urlPath, { json });
  }

  // These REST endpoints all wrap their payload as {success, <key>, count}
  // (confirmed against the real running server, not assumed) — unwrap here
  // so callers just get plain arrays, matching the BBS client's convention.
  async listRooms() { const r = await this._request('GET', '/api/chat/rooms'); return r.rooms || []; }
  createRoom(name, description) { return this._request('POST', '/api/chat/rooms', { json: { name, description } }); }
  async getRoomUsers(name) { const r = await this._request('GET', `/api/chat/rooms/${encodeURIComponent(name)}/users`); return r.users || []; }
  async getHistory(name, limit = 100) { const r = await this._request('GET', `/api/chat/history/${encodeURIComponent(name)}?limit=${limit}`); return r.messages || []; }

  async switchRoom(name) {
    const s = this._settings();
    const callsign = this._chatCallsign(s);
    if (!callsign) throw new Error('Your callsign is not set in Chat settings');
    if (this.currentRoom && this.currentRoom !== name) {
      await this._request('POST', `/api/chat/rooms/${encodeURIComponent(this.currentRoom)}/leave`, { json: { callsign } }).catch(() => {});
    }
    await this._request('POST', `/api/chat/rooms/${encodeURIComponent(name)}/join`, { json: { callsign, password: s.password || '' } });
    this.currentRoom = name;
    const [history, users] = await Promise.all([this.getHistory(name).catch(() => ({ messages: [] })), this.getRoomUsers(name).catch(() => ({ users: [] }))]);
    return { room: name, history, users };
  }

  sendMessage(text) {
    if (!this.ws || !this.connected) throw new Error('Not connected to chat');
    this.ws.send(JSON.stringify({ type: 'chat-message', text }));
  }

  sendTyping(typing) {
    if (!this.ws || !this.connected) return;
    this.ws.send(JSON.stringify({ type: 'chat-typing', typing }));
  }
}

module.exports = ChatManager;

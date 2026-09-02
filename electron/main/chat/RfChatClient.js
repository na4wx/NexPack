const EventEmitter = require('events');

// Real RF client for NexDigi's RF chat access (server/lib/chatSession.js +
// the "C"/"CHAT" command routed through server/lib/bbsSession.js) —
// verified against that real source, not guessed: chat over RF is entered
// by connecting to the BBS callsign over AX.25 (the exact same endpoint
// RfBbsClient already uses — reuses its settings rather than needing a
// separate RF-chat config) and typing C or CHAT, after which the session
// speaks a real IRC-like slash-command protocol (/join, /msg, /list,
// /users, /quit, ...) with plain typed text sent to whichever room you've
// joined. Unlike RfBbsClient (one short connect/command/disconnect per
// operation), a chat session is inherently long-lived — this stays
// connected and emits events in real time, mirroring ChatManager's own
// public shape (connect/disconnect/listRooms/switchRoom/sendMessage/
// sendTyping, a 'chat-event' stream) so ChatFacade can dispatch to either
// one identically, the same pattern BbsFacade already uses for BBS.
const CONNECT_TIMEOUT_MS = 25000;
const COMMAND_TIMEOUT_MS = 20000;
const QUIET_PERIOD_MS = 500;

class RfChatClient extends EventEmitter {
  constructor({ tncManager, rfBbsClient }) {
    super();
    this.tncManager = tncManager;
    // Chat rides the same AX.25 connection RF BBS already uses — no
    // separate settings file. rfBbsClient is only ever read here (its
    // tncId/radioId/bbsCallsign), never driven with BBS commands.
    this.rfBbsClient = rfBbsClient;
    this.connected = false;
    this.currentRoom = null;
    this.sessionId = null;
    this.ownCallsign = null;
    this._closed = true;
    this._raw = ''; // trailing incomplete line, live-dispatch mode only
    this._pendingWait = null; // {buffer, lastChunkAt, resolve, reject, deadline}
    this._queue = Promise.resolve(); // serializes list/join/users request-response ops
    this._onData = this._onData.bind(this);
    this._onState = this._onState.bind(this);
  }

  // ---- connection lifecycle ----
  async connect() {
    if (this.connected || this.sessionId) return;
    this._closed = false;
    const settings = this.rfBbsClient.getSettings();
    if (!settings.tncId || !settings.radioId || !settings.bbsCallsign) {
      throw new Error('RF chat uses the RF BBS connection — set a TNC/radio and BBS callsign in BBS settings first.');
    }
    const tncs = this.tncManager.listTncs();
    const tnc = tncs.find((t) => t.id === settings.tncId);
    const radio = tnc && tnc.radios.find((r) => r.id === settings.radioId);
    if (!tnc || !radio) throw new Error('The configured TNC/radio for RF BBS no longer exists — check BBS settings.');
    this.ownCallsign = radio.callsign;

    const snap = this.tncManager.startSession(settings.tncId, settings.radioId, settings.bbsCallsign, settings.digiPath || []);
    this.sessionId = snap.id;
    this.tncManager.on('session-data', this._onData);
    this.tncManager.on('session-state', this._onState);

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${settings.bbsCallsign} over RF.`)), CONNECT_TIMEOUT_MS);
        const onState = (s) => {
          if (s.id !== this.sessionId) return;
          if (s.state === 'connected') { clearTimeout(timer); this.tncManager.removeListener('session-state', onState); resolve(); }
          else if (s.state === 'disconnected') { clearTimeout(timer); this.tncManager.removeListener('session-state', onState); reject(new Error(`Connection to ${settings.bbsCallsign} was refused or dropped.`)); }
        };
        this.tncManager.on('session-state', onState);
      });

      // At the BBS main menu now — enter chat mode. The BBS's own welcome
      // banner (and a possible name/QTH onboarding prompt) may still be
      // arriving; give it a moment before typing anything.
      await new Promise((r) => setTimeout(r, 500));
      const chatBanner = await this._waitQuiet(() => this.tncManager.sendSessionText(this.sessionId, 'CHAT'));
      if (/Enter your Name:|Enter your QTH/i.test(chatBanner)) {
        throw new Error(`${settings.bbsCallsign} is asking ${radio.callsign} to set up a BBS account (name/QTH) — connect once via Terminal to complete it before using RF chat.`);
      }

      this.connected = true;
      const defaultRoomMatch = chatBanner.match(/Welcome to (\S+)!/i) || chatBanner.match(/join\s+(\S+)\s+to join the main room/i);
      if (defaultRoomMatch) this.currentRoom = defaultRoomMatch[1].toUpperCase();
      this.emit('chat-event', { type: 'chat-connected', defaultRoom: this.currentRoom });
    } catch (e) {
      this._cleanup();
      this.emit('chat-error', { message: e.message });
      throw e;
    }
  }

  disconnect() {
    this._closed = true;
    if (this.sessionId) {
      try { this.tncManager.sendSessionText(this.sessionId, 'BYE'); } catch (e) { /* ignore */ }
      try { this.tncManager.endSession(this.sessionId); } catch (e) { /* ignore */ }
    }
    this._cleanup();
  }

  _cleanup() {
    this.tncManager.removeListener('session-data', this._onData);
    this.tncManager.removeListener('session-state', this._onState);
    const wasConnected = this.connected;
    this.connected = false;
    this.sessionId = null;
    this.currentRoom = null;
    this._raw = '';
    if (this._pendingWait) { this._pendingWait.reject(new Error('disconnected')); this._pendingWait = null; }
    if (wasConnected) this.emit('chat-event', { type: 'chat-disconnected' });
  }

  _onState(s) {
    if (s.id !== this.sessionId) return;
    if (s.state === 'disconnected' && !this._closed) this._cleanup();
  }

  // ---- incoming text: either feeds an active command wait, or is
  // classified and emitted live as a chat-event ----
  _onData(evt) {
    if (evt.sessionId !== this.sessionId) return;
    if (this._pendingWait) {
      this._pendingWait.buffer += evt.text;
      this._pendingWait.lastChunkAt = Date.now();
      return;
    }
    this._raw += evt.text;
    let idx;
    while ((idx = this._raw.search(/\r\n|\n/)) !== -1) {
      const isCrlf = this._raw[idx] === '\r';
      const line = this._raw.slice(0, idx);
      this._raw = this._raw.slice(idx + (isCrlf ? 2 : 1));
      this._dispatchLine(line);
    }
  }

  _dispatchLine(line) {
    if (!line.trim()) return;
    const roomMsg = line.match(/^\[([A-Za-z0-9\-]+)\]\s(.*)$/);
    const pm = line.match(/^\[PM from ([A-Za-z0-9\-]+)\]\s(.*)$/i);
    const joined = line.match(/^Joined room:\s*(\S+)/i);
    if (joined) this.currentRoom = joined[1].toUpperCase();
    if (pm) {
      this.emit('chat-event', { type: 'chat-private-message', message: { from: pm[1].toUpperCase(), text: pm[2], timestamp: Date.now() } });
    } else if (roomMsg) {
      this.emit('chat-event', { type: 'chat-message', roomName: this.currentRoom, message: { from: roomMsg[1].toUpperCase(), text: roomMsg[2], timestamp: Date.now(), id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } });
    } else {
      // System/status text (join/leave/topic/moderation/errors/etc) — no
      // documented machine-parseable template for these over RF, so they
      // surface as a plain system line the same way ChatWorkspace already
      // renders any chat-message with no roomName.
      this.emit('chat-event', { type: 'chat-message', text: line });
    }
  }

  // Sends text (or runs a side-effecting fn first), then captures
  // everything that arrives until a quiet period — same request/response
  // strategy as RfBbsClient, just layered onto a session that's normally
  // in live-dispatch mode rather than opened fresh per command.
  _waitQuiet(sendFn, timeoutMs = COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      this._pendingWait = { buffer: '', lastChunkAt: 0, resolve, reject };
      sendFn();
      const start = Date.now();
      const check = () => {
        if (!this._pendingWait) return; // already resolved via disconnect
        const w = this._pendingWait;
        if (Date.now() - start > timeoutMs) { this._pendingWait = null; reject(new Error('Timed out waiting for a reply.')); return; }
        if (w.lastChunkAt && w.buffer.length > 0 && Date.now() - w.lastChunkAt > QUIET_PERIOD_MS) {
          this._pendingWait = null;
          resolve(w.buffer);
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  // ---- public API (mirrors ChatManager's shape) ----
  sendMessage(text) {
    if (!this.connected) throw new Error('Not connected to chat');
    this.tncManager.sendSessionText(this.sessionId, text);
  }

  sendTyping() {
    // No RF equivalent worth sending — real value is minimal per NexDigi's
    // own chat design notes, and there's no documented wire format for it.
  }

  listRooms() {
    return this._enqueue(async () => {
      const text = await this._waitQuiet(() => this.tncManager.sendSessionText(this.sessionId, '/list'));
      const rooms = [];
      const re = /^.{0,4}?\s*(\S+)\s+\((\d+)\/(\d+)\)\s+-\s+(.*)$/;
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(re);
        if (m) rooms.push({ name: m[1], userCount: Number(m[2]), maxUsers: Number(m[3]), description: m[4], hasPassword: line.includes('🔒'), persistent: line.includes('📌') });
      }
      return rooms;
    });
  }

  createRoom(name, description) {
    return this._enqueue(async () => {
      const cmd = description ? `/create ${name}` : `/create ${name}`; // chatSession's /create takes name [password] — no description over RF
      const text = await this._waitQuiet(() => this.tncManager.sendSessionText(this.sessionId, cmd));
      if (/^Error:/im.test(text)) throw new Error(text.match(/^Error:\s*(.*)$/im)[1]);
      this.currentRoom = name.toUpperCase();
      return { name: name.toUpperCase() };
    });
  }

  getRoomUsers(name) {
    return this._enqueue(async () => {
      const text = await this._waitQuiet(() => this.tncManager.sendSessionText(this.sessionId, '/users'));
      const users = [];
      const re = /^(?:🟢|🟡)\s*(\S+)/;
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(re);
        if (m) users.push({ callsign: m[1] });
      }
      return users;
    });
  }

  getHistory() {
    // /join's own reply already includes recent history (parsed in
    // switchRoom below) — no separate on-demand history command is worth
    // driving here since switchRoom is the only caller that needs it.
    return Promise.resolve([]);
  }

  switchRoom(name) {
    return this._enqueue(async () => {
      const text = await this._waitQuiet(() => this.tncManager.sendSessionText(this.sessionId, `/join ${name}`));
      if (/^Error:/im.test(text)) throw new Error(text.match(/^Error:\s*(.*)$/im)[1]);
      this.currentRoom = name.toUpperCase();
      const history = [];
      const histSection = text.split(/---\s*Recent messages\s*---/i)[1];
      if (histSection) {
        const re = /^\[[\d:APM\s]+\]\s(\S+):\s(.*)$/;
        for (const line of histSection.split(/\r?\n/)) {
          const m = line.match(re);
          if (m) history.push({ from: m[1], text: m[2], timestamp: Date.now(), id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
        }
      }
      // Piggyback a /users right after joining so the UI's user list isn't
      // left empty until something else happens to trigger a refresh —
      // there's no reliable RF text template for join/leave notifications
      // to hook a live refresh off of (see _dispatchLine), so this is the
      // one point where a real user list is worth actively fetching.
      let users = [];
      try {
        const usersText = await this._waitQuiet(() => this.tncManager.sendSessionText(this.sessionId, '/users'));
        const re = /^(?:🟢|🟡)\s*(\S+)/;
        for (const line of usersText.split(/\r?\n/)) {
          const m = line.match(re);
          if (m) users.push({ callsign: m[1] });
        }
      } catch (e) { /* best-effort — room join itself already succeeded */ }
      return { room: this.currentRoom, history, users };
    });
  }
}

module.exports = RfChatClient;

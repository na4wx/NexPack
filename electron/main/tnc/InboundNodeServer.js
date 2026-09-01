const ChatManager = require('../chat/ChatManager');

function baseCall(call) {
  return String(call || '').split('-')[0].toUpperCase();
}

// Serves inbound RF connections as a small text-menu node: connecting to
// Terminal's own identity gets a preamble + "CHAT or BBS" menu; connecting
// directly to the BBS or Chat identity drops straight into that mode with
// no preamble. Purely reactive to TncManager's existing session-state/
// session-data events — no changes needed to what TncManager emits, this
// just adds a listener the same way AprsManager does.
class InboundNodeServer {
  constructor({ tncManager, bbsFacade, nexDigiClient, terminalSettings, inboundServerSettings }) {
    this.tncManager = tncManager;
    this.bbsFacade = bbsFacade;
    this.nexDigiClient = nexDigiClient;
    this.terminalSettings = terminalSettings;
    this.inboundServerSettings = inboundServerSettings;
    this.sessions = new Map(); // sessionId -> { mode, remoteCall, inputBuffer, bbsState, chatManager }

    tncManager.on('session-state', (snap) => this._onSessionState(snap));
    tncManager.on('session-data', (evt) => this._onSessionData(evt));
  }

  // Which configured server identity (if any) this session's radio matches.
  // Terminal's radio is read live from TerminalSettings rather than stored
  // here too, since the user wants one callsign-SSID to serve as both
  // Terminal's own outbound default and the node-menu identity.
  _matchIdentity(snap) {
    const term = this.terminalSettings.getSettings();
    const inbound = this.inboundServerSettings.getSettings();
    if (inbound.node.enabled && term.defaultTncId && term.defaultRadioId && snap.tncId === term.defaultTncId && snap.radioId === term.defaultRadioId) return 'node';
    if (inbound.bbs.enabled && inbound.bbs.tncId && inbound.bbs.radioId && snap.tncId === inbound.bbs.tncId && snap.radioId === inbound.bbs.radioId) return 'bbs';
    if (inbound.chat.enabled && inbound.chat.tncId && inbound.chat.radioId && snap.tncId === inbound.chat.tncId && snap.radioId === inbound.chat.radioId) return 'chat';
    return null;
  }

  _onSessionState(snap) {
    if (snap.state === 'connected') {
      if (this.sessions.has(snap.id)) return; // already tracked — a duplicate/retried SABM on the same live session
      const identity = this._matchIdentity(snap);
      if (!identity) return; // not one of our server identities — leave it for manual Terminal use, untouched
      const s = { mode: null, remoteCall: snap.remoteCall, inputBuffer: '', bbsState: { composing: null, postRead: null }, chatManager: null };
      this.sessions.set(snap.id, s);
      if (identity === 'node') {
        s.mode = 'menu';
        const preamble = (this.inboundServerSettings.getSettings().node.preamble || '').replace(/\{callsign\}/g, snap.remoteCall);
        this._sendLines(snap.id, preamble);
      } else if (identity === 'bbs') {
        this._enterBbs(snap.id, s);
      } else if (identity === 'chat') {
        this._enterChat(snap.id, s);
      }
      return;
    }
    if (snap.state === 'disconnected') {
      const s = this.sessions.get(snap.id);
      if (!s) return;
      if (s.chatManager) { try { s.chatManager.disconnect(); s.chatManager.removeAllListeners(); } catch (e) { /* ignore */ } }
      this.sessions.delete(snap.id);
    }
  }

  // Buffers raw session-data text into complete lines before dispatching —
  // a remote's typed input can arrive as multiple I-frames per line or
  // multiple lines per I-frame, not necessarily one event per line.
  _onSessionData(evt) {
    const s = this.sessions.get(evt.sessionId);
    if (!s) return;
    s.inputBuffer += evt.text.replace(/\r\n?/g, '\n');
    let idx;
    while ((idx = s.inputBuffer.indexOf('\n')) !== -1) {
      const line = s.inputBuffer.slice(0, idx);
      s.inputBuffer = s.inputBuffer.slice(idx + 1);
      this._handleLine(evt.sessionId, s, line);
    }
  }

  _handleLine(sessionId, s, line) {
    if (s.mode === 'menu') return this._handleMenuLine(sessionId, s, line);
    if (s.mode === 'bbs') return this._handleBbsLine(sessionId, s, line);
    if (s.mode === 'chat') return this._handleChatLine(sessionId, s, line);
  }

  _sendLines(sessionId, text) {
    for (const line of String(text || '').split('\n')) {
      try { this.tncManager.sendSessionLine(sessionId, line); } catch (e) { /* session likely just ended */ }
    }
  }

  // ---- menu mode ----
  _handleMenuLine(sessionId, s, line) {
    const cmd = line.trim().toUpperCase();
    if (cmd === 'CHAT') return this._enterChat(sessionId, s);
    if (cmd === 'BBS') return this._enterBbs(sessionId, s);
    if (cmd === 'BYE') return this.tncManager.endSession(sessionId);
    this._sendLines(sessionId, 'Reply CHAT or BBS, or BYE to disconnect.');
  }

  // ---- BBS mode ----
  _enterBbs(sessionId, s) {
    s.mode = 'bbs';
    s.bbsState = { composing: null, postRead: null };
    this._bbsPrompt(sessionId);
  }

  _bbsPrompt(sessionId) {
    this._sendLines(sessionId, 'CMD (H = Help)');
  }

  _handleBbsLine(sessionId, s, line) {
    if (s.bbsState.composing) return this._bbsComposeLine(sessionId, s, line);
    if (s.bbsState.postRead) return this._bbsPostReadLine(sessionId, s, line);

    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();
    if (upper === 'BYE') { this.tncManager.endSession(sessionId); return; }
    if (upper === 'H' || upper === 'HELP' || upper === '?') return this._bbsHelp(sessionId);
    if (upper === 'L') return this._bbsList(sessionId);
    if (upper === 'P') return this._bbsPersonal(sessionId, s);
    const readMatch = /^R\s+(\d+)$/i.exec(trimmed);
    if (readMatch) return this._bbsRead(sessionId, s, Number(readMatch[1]));
    const composeMatch = /^M\s+(\S+)$/i.exec(trimmed);
    if (composeMatch) return this._bbsComposeStart(sessionId, s, composeMatch[1]);

    this._sendLines(sessionId, 'Unknown command. H for help.');
    this._bbsPrompt(sessionId);
  }

  async _bbsHelp(sessionId) {
    this._sendLines(sessionId, [
      'BBS commands:',
      'H          - This help',
      'L          - List bulletins',
      'P          - List your personal messages',
      'R n        - Read message n',
      'M call     - Compose a message to call',
      'BYE        - Disconnect'
    ].join('\n'));
    this._bbsPrompt(sessionId);
  }

  async _bbsList(sessionId) {
    try {
      const bulletins = await this.bbsFacade.listBulletins();
      if (!bulletins || bulletins.length === 0) {
        this._sendLines(sessionId, 'No bulletin messages available.');
      } else {
        this._sendLines(sessionId, bulletins.map((m) => this._formatListLine(m)).join('\n'));
      }
    } catch (e) {
      this._sendLines(sessionId, `[error: ${e.message}]`);
    }
    this._bbsPrompt(sessionId);
  }

  async _bbsPersonal(sessionId, s) {
    try {
      const all = await this.bbsFacade.listMessages({});
      const base = baseCall(s.remoteCall);
      const mine = (all || []).filter((m) => baseCall(m.recipient) === base);
      if (mine.length === 0) {
        this._sendLines(sessionId, `No personal messages for ${base}*.`);
      } else {
        this._sendLines(sessionId, mine.map((m) => `${this._formatListLine(m)} [${m.read ? 'READ' : 'NEW'}]`).join('\n'));
      }
    } catch (e) {
      this._sendLines(sessionId, `[error: ${e.message}]`);
    }
    this._bbsPrompt(sessionId);
  }

  _formatListLine(m) {
    const date = m.timestamp ? ` (${new Date(m.timestamp).toLocaleDateString()})` : '';
    return `${m.messageNumber}: From ${m.sender} - ${m.subject}${date}`;
  }

  async _bbsRead(sessionId, s, n) {
    try {
      // listMessages()/listBulletins() already carry full content per item
      // under HTTP transport; markRead() itself only returns full content
      // under RF transport (see RfBbsClient) — check both so a message
      // reads correctly either way.
      const [personal, bulletins] = await Promise.all([this.bbsFacade.listMessages({}), this.bbsFacade.listBulletins()]);
      const msg = [...(personal || []), ...(bulletins || [])].find((m) => m.messageNumber === n);
      if (!msg) {
        this._sendLines(sessionId, `Message ${n} not found.`);
        this._bbsPrompt(sessionId);
        return;
      }
      const marked = await this.bbsFacade.markRead(n).catch(() => null);
      const content = (marked && typeof marked === 'object' && marked.content !== undefined) ? marked.content : msg.content;
      this._sendLines(sessionId, [`From: ${msg.sender}`, `Subject: ${msg.subject}`, '', content || '', '', 'Options: D=Delete, Enter=Return to menu'].join('\n'));
      s.bbsState.postRead = { messageNumber: n };
    } catch (e) {
      this._sendLines(sessionId, `[error: ${e.message}]`);
      this._bbsPrompt(sessionId);
    }
  }

  async _bbsPostReadLine(sessionId, s, line) {
    const upper = line.trim().toUpperCase();
    const n = s.bbsState.postRead.messageNumber;
    s.bbsState.postRead = null;
    if (upper === 'D') {
      try {
        await this.bbsFacade.deleteMessage(n);
        this._sendLines(sessionId, `Message ${n} deleted.`);
      } catch (e) {
        this._sendLines(sessionId, `[error: ${e.message}]`);
      }
    }
    this._bbsPrompt(sessionId);
  }

  _bbsComposeStart(sessionId, s, recipient) {
    s.bbsState.composing = { recipient: recipient.toUpperCase(), lines: [] };
    this._sendLines(sessionId, 'Enter message (end with . on new line):');
  }

  async _bbsComposeLine(sessionId, s, line) {
    if (line !== '.') {
      s.bbsState.composing.lines.push(line);
      return;
    }
    const { recipient, lines } = s.bbsState.composing;
    s.bbsState.composing = null;
    const content = lines.join('\n');
    if (!content.trim()) {
      this._sendLines(sessionId, 'Message cancelled (empty).');
      this._bbsPrompt(sessionId);
      return;
    }
    try {
      const result = await this.bbsFacade.postMessage({ recipient, subject: 'BBS Message', content, senderOverride: s.remoteCall });
      const n = result && result.messageNumber;
      this._sendLines(sessionId, n ? `Message sent to ${recipient} (stored as #${n}).` : `Message sent to ${recipient}.`);
    } catch (e) {
      this._sendLines(sessionId, `[error: ${e.message}]`);
    }
    this._bbsPrompt(sessionId);
  }

  // ---- Chat mode ----
  _enterChat(sessionId, s) {
    s.mode = 'chat';
    // A fresh instance per session — never the app's own singleton
    // ChatManager, which has exactly one shared ws/currentRoom/identity and
    // would collide with (and leak into) the local operator's own Chat UI.
    const cm = new ChatManager({ nexDigiClient: this.nexDigiClient, callsignOverride: s.remoteCall });
    s.chatManager = cm;
    cm.on('chat-event', (msg) => this._onChatEvent(sessionId, s, msg));
    cm.on('chat-error', (e) => this._sendLines(sessionId, `[chat error: ${e.message}]`));
    try {
      cm.connect();
    } catch (e) {
      this._sendLines(sessionId, `[chat unavailable: ${e.message}]`);
    }
  }

  _onChatEvent(sessionId, s, msg) {
    if (msg.type === 'chat-connected') {
      const room = this.inboundServerSettings.getSettings().chat.defaultRoom || 'LOBBY';
      s.chatManager.switchRoom(room)
        .then(() => this._sendLines(sessionId, `Joined ${room}. Type BYE to disconnect.`))
        .catch((e) => this._sendLines(sessionId, `[chat error: ${e.message}]`));
      return;
    }
    if (msg.type === 'chat-message' && msg.message) {
      this._sendLines(sessionId, `${msg.message.from}: ${msg.message.text}`);
    }
  }

  _handleChatLine(sessionId, s, line) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BYE') {
      if (s.chatManager) { try { s.chatManager.disconnect(); } catch (e) { /* ignore */ } }
      this.tncManager.endSession(sessionId);
      return;
    }
    if (!line.trim()) return;
    try { s.chatManager.sendMessage(line); } catch (e) { this._sendLines(sessionId, `[chat error: ${e.message}]`); }
  }
}

module.exports = InboundNodeServer;

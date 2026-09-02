const fs = require('fs');
const path = require('path');

// Routes the Chat IPC surface to whichever transport (HTTP+WebSocket via
// ChatManager, or RF via RfChatClient) the user has currently selected —
// same shape/purpose as BbsFacade for BBS. Both clients expose the same
// method names and emit the same 'chat-event'/'chat-error' shapes, so
// index.js only needs to forward whichever one is currently active.
class ChatFacade {
  constructor({ userDataDir, chatManager, rfChatClient }) {
    this.configPath = path.join(userDataDir, 'chat-transport.json');
    this.chatManager = chatManager;
    this.rfChatClient = rfChatClient;
  }

  getTransport() {
    if (!fs.existsSync(this.configPath)) return 'http';
    try { return JSON.parse(fs.readFileSync(this.configPath, 'utf8')).transport || 'http'; } catch (e) { return 'http'; }
  }

  // Switching transport while connected would leave the old one's session
  // dangling (a live WS or AX.25 connection nobody's listening to anymore)
  // — disconnect it first so only one is ever actually connected.
  setTransport(transport) {
    const t = transport === 'rf' ? 'rf' : 'http';
    const current = this.getTransport();
    if (t !== current) { try { this._active(current).disconnect(); } catch (e) { /* ignore */ } }
    fs.writeFileSync(this.configPath, JSON.stringify({ transport: t }, null, 2));
    return t;
  }

  _active(transport) {
    return (transport || this.getTransport()) === 'rf' ? this.rfChatClient : this.chatManager;
  }

  connect() { return this._active().connect(); }
  disconnect() { return this._active().disconnect(); }
  listRooms() { return this._active().listRooms(); }
  createRoom(name, description) { return this._active().createRoom(name, description); }
  switchRoom(name) { return this._active().switchRoom(name); }
  getRoomUsers(name) { return this._active().getRoomUsers(name); }
  sendMessage(text) { return this._active().sendMessage(text); }
  sendTyping(typing) { return this._active().sendTyping(typing); }
}

module.exports = ChatFacade;

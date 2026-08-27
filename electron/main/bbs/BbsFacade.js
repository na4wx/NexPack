const fs = require('fs');
const path = require('path');

// Routes the BBS IPC surface to whichever transport (HTTP via NexDigiClient,
// or RF via RfBbsClient) the user has currently selected — both expose the
// same method names, so this is a thin dispatcher plus the one bit of state
// ("which transport is active") that doesn't belong to either client.
class BbsFacade {
  constructor({ userDataDir, nexDigiClient, rfBbsClient }) {
    this.configPath = path.join(userDataDir, 'bbs-transport.json');
    this.nexDigiClient = nexDigiClient;
    this.rfBbsClient = rfBbsClient;
  }

  getTransport() {
    if (!fs.existsSync(this.configPath)) return 'http';
    try { return JSON.parse(fs.readFileSync(this.configPath, 'utf8')).transport || 'http'; } catch (e) { return 'http'; }
  }

  setTransport(transport) {
    const t = transport === 'rf' ? 'rf' : 'http';
    fs.writeFileSync(this.configPath, JSON.stringify({ transport: t }, null, 2));
    return t;
  }

  _active() {
    return this.getTransport() === 'rf' ? this.rfBbsClient : this.nexDigiClient;
  }

  listMessages(filters) { return this._active().listMessages(filters); }
  postMessage(message) { return this._active().postMessage(message); }
  markRead(messageNumber) { return this._active().markRead(messageNumber); }
  deleteMessage(messageNumber) { return this._active().deleteMessage(messageNumber); }
  listBulletins() { return this._active().listBulletins(); }
  getStats() { return this._active().getStats(); }
}

module.exports = BbsFacade;

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  node: { enabled: false, preamble: 'Welcome to {callsign}!\nReply CHAT or BBS, or BYE to disconnect.' },
  bbs: { enabled: false, tncId: null, radioId: null },
  chat: { enabled: false, tncId: null, radioId: null, defaultRoom: 'LOBBY' }
};

// Which of Terminal/BBS/Chat accept inbound RF connections, and where.
// Terminal's own identity (radio) is deliberately NOT duplicated here — it's
// read live from TerminalSettings at connect time, since the user wants one
// callsign-SSID to serve as both Terminal's outbound default and the
// node-menu identity remote stations connect to.
class InboundServerSettings {
  constructor({ userDataDir }) {
    this.configPath = path.join(userDataDir, 'inbound-server.json');
  }

  getSettings() {
    if (!fs.existsSync(this.configPath)) return JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return {
        node: { ...DEFAULTS.node, ...(raw.node || {}) },
        bbs: { ...DEFAULTS.bbs, ...(raw.bbs || {}) },
        chat: { ...DEFAULTS.chat, ...(raw.chat || {}) }
      };
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  // Merges over existing settings (and merges each section individually) so
  // the BBS settings panel saving its section can't wipe out Chat's, etc.
  saveSettings(patch) {
    const existing = this.getSettings();
    const merged = {
      node: { ...existing.node, ...(patch.node || {}) },
      bbs: { ...existing.bbs, ...(patch.bbs || {}) },
      chat: { ...existing.chat, ...(patch.chat || {}) }
    };
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
    return merged;
  }
}

module.exports = InboundServerSettings;

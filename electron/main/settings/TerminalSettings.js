const fs = require('fs');
const path = require('path');

// Terminal previously had no persisted settings at all — every session
// picked its radio/path fresh from the toolbar each time, with no way to
// set a default identity. This exists so a user can pin Terminal to a
// specific radio (callsign/SSID) rather than leaving it to whatever was
// last selected, which matters once Terminal, BBS-RF, and APRS beaconing
// might otherwise all end up sharing one radio's callsign on the air.
class TerminalSettings {
  constructor({ userDataDir }) {
    this.configPath = path.join(userDataDir, 'terminal-settings.json');
  }

  getSettings() {
    if (!fs.existsSync(this.configPath)) return { defaultTncId: null, defaultRadioId: null, defaultDigiPath: '' };
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return { defaultTncId: raw.defaultTncId || null, defaultRadioId: raw.defaultRadioId || null, defaultDigiPath: raw.defaultDigiPath || '' };
    } catch (e) {
      return { defaultTncId: null, defaultRadioId: null, defaultDigiPath: '' };
    }
  }

  saveSettings(settings) {
    const merged = { ...this.getSettings(), ...settings };
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
    return merged;
  }
}

module.exports = TerminalSettings;

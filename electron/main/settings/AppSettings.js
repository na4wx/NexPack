const fs = require('fs');
const path = require('path');

const DEFAULTS = { defaultPage: 'terminal', showTncStatusBar: true };

// App-wide settings — things that apply to NexPack as a whole rather than
// to any one workspace (Terminal/Winlink/NexChat/APRS/BBS each keep their
// own settings): which page to land on at launch, and whether to show the
// minimal TNC status bar (TX/RX/DEC lights per configured TNC) — useful to
// turn off on smaller screens.
class AppSettings {
  constructor({ userDataDir }) {
    this.configPath = path.join(userDataDir, 'app-settings.json');
  }

  getSettings() {
    if (!fs.existsSync(this.configPath)) return { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return {
        defaultPage: raw.defaultPage || DEFAULTS.defaultPage,
        showTncStatusBar: raw.showTncStatusBar !== undefined ? !!raw.showTncStatusBar : DEFAULTS.showTncStatusBar
      };
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  saveSettings(settings) {
    const merged = { ...this.getSettings(), ...settings };
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
    return merged;
  }
}

module.exports = AppSettings;

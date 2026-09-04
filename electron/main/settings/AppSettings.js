const fs = require('fs');
const path = require('path');

// App-wide settings — things that apply to NexPack as a whole rather than
// to any one workspace (Terminal/Winlink/NexChat/APRS/BBS each keep their
// own settings). Currently just which page to land on at launch, instead
// of always starting on Terminal regardless of what the user actually
// uses NexPack for day to day.
class AppSettings {
  constructor({ userDataDir }) {
    this.configPath = path.join(userDataDir, 'app-settings.json');
  }

  getSettings() {
    if (!fs.existsSync(this.configPath)) return { defaultPage: 'terminal' };
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return { defaultPage: raw.defaultPage || 'terminal' };
    } catch (e) {
      return { defaultPage: 'terminal' };
    }
  }

  saveSettings(settings) {
    const merged = { ...this.getSettings(), ...settings };
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
    return merged;
  }
}

module.exports = AppSettings;

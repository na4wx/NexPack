const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WAITFOR_TIMEOUT_MS = 30000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Persisted connect scripts (auto-send/wait sequences), run against a
// TncManager session — e.g. an automated BBS login handshake, matching
// paKet's "automatic script processing" feature.
class ScriptManager {
  constructor({ userDataDir, tncManager }) {
    this.configPath = path.join(userDataDir, 'scripts.json');
    this.tncManager = tncManager;
    this.scripts = this._load();
    this.running = new Map(); // sessionId -> { abort: fn }

    this.tncManager.on('session-state', (snap) => {
      if (snap.state === 'connected' && snap.pendingScriptId) this._autoRun(snap);
    });
  }

  _load() {
    if (!fs.existsSync(this.configPath)) return [];
    try { return JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch (e) { return []; }
  }

  _save() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.scripts, null, 2));
  }

  listScripts() { return this.scripts.slice(); }

  saveScript(script) {
    const withId = { ...script, id: script.id || crypto.randomUUID() };
    const idx = this.scripts.findIndex((s) => s.id === withId.id);
    if (idx === -1) this.scripts.push(withId); else this.scripts[idx] = withId;
    this._save();
    return withId;
  }

  deleteScript(scriptId) {
    this.scripts = this.scripts.filter((s) => s.id !== scriptId);
    this._save();
  }

  _autoRun(snap) {
    const script = this.scripts.find((s) => s.id === snap.pendingScriptId);
    if (!script) return;
    this.runScript(snap.id, script.id).catch(() => { /* surfaced via events below */ });
  }

  async runScript(sessionId, scriptId) {
    const script = this.scripts.find((s) => s.id === scriptId);
    if (!script) throw new Error('unknown script');
    if (this.running.has(sessionId)) throw new Error('a script is already running on this session');

    let aborted = false;
    let disconnected = false;
    const onState = (snap) => { if (snap.id === sessionId && snap.state === 'disconnected') disconnected = true; };
    this.tncManager.on('session-state', onState);
    this.running.set(sessionId, { abort: () => { aborted = true; } });

    try {
      for (const step of script.steps) {
        if (aborted || disconnected) throw new Error('script aborted');
        if (step.type === 'send') {
          this.tncManager.sendSessionText(sessionId, step.text);
        } else if (step.type === 'wait') {
          await delay(step.ms || 0);
        } else if (step.type === 'waitFor') {
          await this._waitFor(sessionId, step.pattern, () => aborted || disconnected);
        }
      }
      this.tncManager.emit('script-complete', { sessionId, scriptId });
    } catch (e) {
      this.tncManager.emit('script-error', { sessionId, scriptId, message: e.message });
    } finally {
      this.tncManager.removeListener('session-state', onState);
      this.running.delete(sessionId);
    }
  }

  _waitFor(sessionId, pattern, isCancelled) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for "${pattern}"`)); }, WAITFOR_TIMEOUT_MS);
      const poll = setInterval(() => { if (isCancelled()) { cleanup(); reject(new Error('cancelled')); } }, 200);
      const onData = (evt) => {
        if (evt.sessionId !== sessionId) return;
        if (evt.text && evt.text.includes(pattern)) { cleanup(); resolve(); }
      };
      const cleanup = () => { clearTimeout(timer); clearInterval(poll); this.tncManager.removeListener('session-data', onData); };
      this.tncManager.on('session-data', onData);
    });
  }

  abortScript(sessionId) {
    const entry = this.running.get(sessionId);
    if (entry) entry.abort();
  }
}

module.exports = ScriptManager;

const fs = require('fs');
const path = require('path');

// Real network client to a running NexDigi server's BBS REST API
// (server/routes/bbs.js in the NexDigi repo, mounted at /api/bbs).
// Unlike Winlink, BBS messages genuinely live on the digipeater — this is
// the one piece of the mail section that talks to NexDigi at all.
class NexDigiClient {
  constructor({ userDataDir }) {
    this.configPath = path.join(userDataDir, 'nexdigi-server.json');
  }

  getSettings() {
    if (!fs.existsSync(this.configPath)) return null;
    try { return JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch (e) { return null; }
  }

  saveSettings({ host, password, callsign, protocol = 'http' }) {
    const settings = { host, password, callsign: (callsign || '').toUpperCase(), protocol };
    fs.writeFileSync(this.configPath, JSON.stringify(settings, null, 2));
    return settings;
  }

  _baseUrl() {
    const s = this.getSettings();
    if (!s || !s.host) throw new Error('NexDigi server not configured');
    return `${s.protocol || 'http'}://${s.host}`;
  }

  async _request(method, urlPath, { json } = {}) {
    const s = this.getSettings();
    if (!s || !s.host) throw new Error('NexDigi server not configured');
    const res = await fetch(`${this._baseUrl()}${urlPath}`, {
      method,
      headers: { 'X-UI-Password': s.password || '', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`NexDigi ${method} ${urlPath} -> ${res.status}: ${text}`);
    try { return text ? JSON.parse(text) : null; } catch (e) { return text; }
  }

  listMessages(filters = {}) {
    const qs = new URLSearchParams(filters).toString();
    return this._request('GET', `/api/bbs/messages${qs ? '?' + qs : ''}`);
  }

  postMessage({ recipient, subject, content, category = 'P', priority = 'N', tags = [], replyTo }) {
    const s = this.getSettings();
    if (!s || !s.callsign) throw new Error('Your callsign is not set in BBS settings');
    return this._request('POST', '/api/bbs/messages', { json: { sender: s.callsign, recipient, subject, content, category, priority, tags, replyTo } });
  }

  markRead(messageNumber) { return this._request('PUT', `/api/bbs/messages/${encodeURIComponent(messageNumber)}/read`); }
  deleteMessage(messageNumber) { return this._request('DELETE', `/api/bbs/messages/${encodeURIComponent(messageNumber)}`); }
  listBulletins() { return this._request('GET', '/api/bbs/bulletins'); }
  getStats() { return this._request('GET', '/api/bbs/stats'); }
}

module.exports = NexDigiClient;

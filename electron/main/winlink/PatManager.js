const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const EventEmitter = require('events');
const WebSocket = require('ws');

const CONNECT_TIMEOUT_MS = 120000;

// Manages a bundled `pat` (github.com/la5nta/pat, GPL-3.0) subprocess as
// NexPack's real Winlink client. Real B2F (proposal exchange, LZHUF
// compression, and the officially-undocumented secure-login checksum used
// for CMS Telnet access) is genuinely hard to implement correctly from
// scratch — pat already does it correctly. Running it as a separate
// subprocess and talking to it over HTTP is "mere aggregation," not
// linking: pat stays GPL-3.0 under its own bundled LICENSE, NexPack's own
// code stays MIT. The user never sees pat's own web GUI or CLI — NexPack
// drives it entirely through its HTTP API (documented by hand below; pat
// has no formal REST reference, so this was reverse-engineered by running
// pat locally and inspecting its own bundled web GUI's real network
// traffic and JS source, not by reading pat's source code).
//
// Verified API surface (folder is one of in/out/sent/archive):
//   GET    /api/mailbox/{folder}            -> [{MID,Date,From,To,Cc,Subject,Body:"",BodyHTML:"",Files,P2POnly,Unread}]
//   GET    /api/mailbox/{folder}/{mid}       -> same shape, Body/BodyHTML populated
//   POST   /api/mailbox/out  (multipart)     -> compose/send. Fields: to, cc, subject, body, p2ponly, files[], date, in_reply_to
//   POST   /api/mailbox/{folder}/{mid}/read  (json {read:true})
//   DELETE /api/mailbox/{folder}/{mid}
//   POST   /api/mailbox/archive  (header X-Pat-SourcePath: /api/mailbox/{folder}/{mid})
//   GET    /api/config                       -> full config.json
//   GET/POST/DELETE /api/config/connect_aliases[/{name}]
//   GET    /api/connect?url=<encoded>        -> blocks until session ends, {NumReceived}
//   POST   /api/disconnect?dirty=<bool>
//   GET    /api/rmslist?...                  -> RMS gateway directory search
//   WS     /ws                               -> live status/console feed (JSON messages)
class PatManager extends EventEmitter {
  constructor({ userDataDir, resourcesPath }) {
    super();
    this.dataDir = path.join(userDataDir, 'winlink');
    this.configPath = path.join(this.dataDir, 'config.json');
    this.mboxDir = path.join(this.dataDir, 'mbox');
    this.pidFilePath = path.join(this.dataDir, 'pat.pid');
    this.resourcesPath = resourcesPath;
    this.port = null;
    this.proc = null;
    this.ws = null;
    this._connecting = false;
    fs.mkdirSync(this.mboxDir, { recursive: true });
  }

  // If a previous run of NexPack died without cleanly stopping pat (crash,
  // force-quit, kill -9 — none of which JS shutdown handlers can catch),
  // the subprocess is orphaned but keeps running. It can then serialize a
  // stuck/slow session behind any future connect attempt, which looks like
  // NexPack itself hanging. Called before every start() to reap it first.
  async _reapStaleProcess() {
    let pid;
    try { pid = parseInt(fs.readFileSync(this.pidFilePath, 'utf8').trim(), 10); } catch (e) { return; }
    if (!pid || Number.isNaN(pid)) { this._removePidFile(); return; }
    if (!this._isAlive(pid)) { this._removePidFile(); return; }
    if (!this._looksLikePat(pid)) { this._removePidFile(); return; } // pid reused by an unrelated process
    this.emit('log', `Found a leftover pat process (pid ${pid}) from a previous run — stopping it before starting a fresh one.\n`);
    await this._killPid(pid);
    this._removePidFile();
  }

  _isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
  }

  _looksLikePat(pid) {
    if (process.platform === 'win32') return true; // best-effort elsewhere; skip the comm-name check
    try {
      const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
      return /\bpat(\.exe)?$/i.test(comm) || comm.toLowerCase().includes('pat');
    } catch (e) {
      return false; // process vanished or ps failed — treat as not-ours, don't kill blindly
    }
  }

  async _killPid(pid) {
    try { process.kill(pid, 'SIGTERM'); } catch (e) { return; }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && this._isAlive(pid)) { await new Promise((r) => setTimeout(r, 100)); }
    if (this._isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ } }
  }

  _removePidFile() {
    try { fs.unlinkSync(this.pidFilePath); } catch (e) { /* ignore */ }
  }

  _resolveBinaryPath() {
    if (process.env.NEXPACK_PAT_PATH) return process.env.NEXPACK_PAT_PATH;
    if (this.resourcesPath) {
      const platDir = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
      const bin = process.platform === 'win32' ? 'pat.exe' : 'pat';
      const bundled = path.join(this.resourcesPath, 'pat', platDir, bin);
      if (fs.existsSync(bundled)) return bundled;
    }
    // Dev fallback: rely on `pat` being on PATH (e.g. `go install github.com/la5nta/pat@latest`).
    return 'pat';
  }

  getSettings() {
    if (!fs.existsSync(this.configPath)) return null;
    try { return JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch (e) { return null; }
  }

  // Writes pat's config.json from NexPack's own Winlink settings form.
  // `connectAliases` lets the user name RF (ax25:///CALLSIGN) and Telnet targets.
  saveSettings({ callsign, winlinkPassword, connectAliases = {}, ax25, agwpe }) {
    const base = this.getSettings() || {};
    const merged = {
      ...base,
      mycall: (callsign || '').toUpperCase(),
      secure_login_password: winlinkPassword || '',
      http_addr: base.http_addr || '127.0.0.1:0',
      connect_aliases: { ...(base.connect_aliases || {}), ...connectAliases },
      ax25: ax25 || base.ax25 || { engine: 'agwpe', rig: '', beacon: { every: 0, message: '', destination: 'IDENT' } },
      agwpe: agwpe || base.agwpe || { addr: '127.0.0.1:8000', radio_port: 0 }
    };
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
    return merged;
  }

  async start() {
    if (this.proc) return;
    if (!this.getSettings()) throw new Error('Winlink settings not configured yet');

    await this._reapStaleProcess();

    // Port 0 above means "let pat pick a free port"; we ask the OS for one
    // ourselves and pin it in the config so we know it before spawning.
    const net = require('net');
    this.port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
      srv.on('error', reject);
    });
    const settings = this.getSettings();
    settings.http_addr = `127.0.0.1:${this.port}`;
    fs.writeFileSync(this.configPath, JSON.stringify(settings, null, 2));

    const bin = this._resolveBinaryPath();
    this.proc = spawn(bin, ['--config', this.configPath, '--mbox', this.mboxDir, 'http'], { stdio: ['ignore', 'pipe', 'pipe'] });
    fs.writeFileSync(this.pidFilePath, String(this.proc.pid));
    this.proc.stdout.on('data', (d) => this.emit('log', d.toString()));
    this.proc.stderr.on('data', (d) => this.emit('log', d.toString()));
    this.proc.on('exit', (code) => { this.emit('exit', code); this.proc = null; this._removePidFile(); this._closeSocket(); });
    this.proc.on('error', (err) => this.emit('error', err));

    await this._waitForHttp();
    this._connectSocket();
  }

  async _waitForHttp(timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: this.port, path: '/api/config', timeout: 500 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('pat did not start listening in time');
  }

  _connectSocket() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    this.ws.on('message', (data) => {
      try { this.emit('status', JSON.parse(data.toString())); } catch (e) { /* ignore non-JSON frames */ }
    });
    this.ws.on('error', () => { /* status feed is best-effort */ });
  }

  _closeSocket() {
    try { this.ws && this.ws.close(); } catch (e) { /* ignore */ }
    this.ws = null;
  }

  // Async and defensive: SIGTERM, then SIGKILL if it hasn't exited after a
  // few seconds. Safe to call even if start() never ran, or was called
  // multiple times (app quit + explicit user action racing each other).
  async stop() {
    this._closeSocket();
    if (!this.proc) return;
    const pid = this.proc.pid;
    this.proc.kill('SIGTERM');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && this._isAlive(pid)) { await new Promise((r) => setTimeout(r, 100)); }
    if (this._isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ } }
    this.proc = null;
    this._removePidFile();
  }

  _url(p) { return `http://127.0.0.1:${this.port}${p}`; }

  async _request(method, urlPath, { json, headers, timeoutMs = 20000 } = {}) {
    const res = await fetch(this._url(urlPath), {
      method,
      headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`pat ${method} ${urlPath} -> ${res.status}: ${text}`);
    try { return text ? JSON.parse(text) : null; } catch (e) { return text; }
  }

  listMessages(folder) { return this._request('GET', `/api/mailbox/${encodeURIComponent(folder)}`); }
  getMessage(folder, mid) { return this._request('GET', `/api/mailbox/${encodeURIComponent(folder)}/${encodeURIComponent(mid)}`); }
  markRead(folder, mid, read = true) { return this._request('POST', `/api/mailbox/${encodeURIComponent(folder)}/${encodeURIComponent(mid)}/read`, { json: { read } }); }
  deleteMessage(folder, mid) { return this._request('DELETE', `/api/mailbox/${encodeURIComponent(folder)}/${encodeURIComponent(mid)}`); }
  archiveMessage(folder, mid) {
    return this._request('POST', '/api/mailbox/archive', { headers: { 'X-Pat-SourcePath': `/api/mailbox/${encodeURIComponent(folder)}/${encodeURIComponent(mid)}` } });
  }

  async sendMessage({ to, cc = '', subject, body, p2pOnly = false, files = [], inReplyTo }) {
    const form = new FormData();
    form.append('to', to);
    if (cc) form.append('cc', cc);
    form.append('subject', subject);
    form.append('body', body);
    if (p2pOnly) form.append('p2ponly', 'on');
    form.append('date', new Date().toISOString());
    if (inReplyTo) form.append('in_reply_to', inReplyTo);
    for (const f of files) form.append('files', new Blob([f.data]), f.name);
    const res = await fetch(this._url('/api/mailbox/out'), { method: 'POST', body: form });
    const text = await res.text();
    if (!res.ok) throw new Error(`send failed -> ${res.status}: ${text}`);
    return text;
  }

  getConnectAliases() { return this._request('GET', '/api/config/connect_aliases'); }
  setConnectAlias(name, url) { return this._request('POST', `/api/config/connect_aliases/${encodeURIComponent(name)}`, { json: url }); }
  removeConnectAlias(name) { return this._request('DELETE', `/api/config/connect_aliases/${encodeURIComponent(name)}`); }

  // Blocks until the connect session completes (pat's own behavior) —
  // callers should await this from an IPC handler, not the renderer directly.
  // Guarded against overlapping calls: pat serializes connect sessions
  // internally, so a second concurrent call would just queue silently
  // behind the first and *look* like a hang — reject it immediately with a
  // clear reason instead. Also bounded by CONNECT_TIMEOUT_MS: a real B2F
  // session can legitimately take a while, but if pat itself wedges (as
  // happened when a prior NexPack process died and orphaned it), we try to
  // unstick it via disconnect(true) rather than leaving the UI stuck.
  async connect(url) {
    if (this._connecting) throw new Error('A Winlink connection is already in progress');
    this._connecting = true;
    try {
      return await this._request('GET', `/api/connect?url=${encodeURIComponent(url)}`, { timeoutMs: CONNECT_TIMEOUT_MS });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        try { await this.disconnect(true); } catch (e2) { /* best-effort unstick */ }
        throw new Error(`Connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s and was aborted`);
      }
      throw e;
    } finally {
      this._connecting = false;
    }
  }

  disconnect(dirty = false) { return this._request('POST', `/api/disconnect?dirty=${dirty}`); }

  searchRms(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this._request('GET', `/api/rmslist${qs ? '?' + qs : ''}`);
  }
}

module.exports = PatManager;

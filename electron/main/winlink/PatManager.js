const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const EventEmitter = require('events');
const WebSocket = require('ws');

// pat's own AGWPE client has a confirmed real bug (matches la5nta/pat#405,
// still open upstream as of pat v1.0.0, the latest release): once it's past
// the initial registration handshake and into an active "connecting" state,
// it does not react to an asynchronous disconnect notification from the
// AGWPE server AT ALL — verified directly against the real bundled pat
// binary: a real AgwpeBridgeServer that correctly gives up and sends a
// clean 'd' disconnect ~36s after nobody answers a SABM (5 retries at 6s
// each, TncManager's own real, tested give-up behavior) got pat's HTTP
// /api/connect to hang well past 90s anyway, with nothing further ever
// logged past "Connecting to <call>...". pat will NEVER self-resolve that
// case — this timeout is the only backstop, so it's kept well above
// TncManager's own worst-case AX.25-layer give-up (~36s) so a real,
// eventually-successful connect still has room, but far below the old
// 120s so a genuine no-answer case doesn't cost the user two full minutes
// waiting on a session pat itself has already effectively abandoned.
const CONNECT_TIMEOUT_MS = 60000;

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
  // agwpeBridgePort: the local port of NexPack's own AgwpeBridgeServer (see
  // AgwpeBridgeServer.js) — pat is always pointed at that bridge, never at
  // a real external AGWPE TNC directly. The bridge itself is what actually
  // resolves the user's chosen radio (via getRfRadio() below) and drives it
  // through TncManager, which is how Winlink RF ends up able to use ANY
  // configured radio type (serial/KISS-TCP/AGWPE/Sound Modem) — pat itself
  // still only ever speaks AGWPE, it just never has to know that.
  constructor({ userDataDir, resourcesPath, agwpeBridgePort }) {
    super();
    this.dataDir = path.join(userDataDir, 'winlink');
    this.configPath = path.join(this.dataDir, 'config.json');
    this.rfRadioPath = path.join(this.dataDir, 'rf-radio.json');
    this.mboxDir = path.join(this.dataDir, 'mbox');
    // Standard Winlink Forms (ICS-213, radiograms, etc.) — kept under
    // NexPack's own userData dir like --mbox above, instead of pat's
    // implicit systemwide default location, so it's self-contained and
    // (for tests) properly isolated per instance.
    this.formsDir = path.join(this.dataDir, 'forms');
    this.pidFilePath = path.join(this.dataDir, 'pat.pid');
    this.resourcesPath = resourcesPath;
    this.agwpeBridgePort = agwpeBridgePort;
    this.port = null;
    this.proc = null;
    this.ws = null;
    this._connecting = false;
    fs.mkdirSync(this.mboxDir, { recursive: true });
    fs.mkdirSync(this.formsDir, { recursive: true });
  }

  // Which NexPack radio (from TNCs & Radios) to reach an RMS Gateway
  // through — read live by AgwpeBridgeServer on every connect attempt, not
  // baked into pat's own config.json, since the bridge (not pat) is what
  // actually resolves and drives it.
  getRfRadio() {
    if (!fs.existsSync(this.rfRadioPath)) return null;
    try { return JSON.parse(fs.readFileSync(this.rfRadioPath, 'utf8')); } catch (e) { return null; }
  }

  _saveRfRadio(rfRadio) {
    fs.writeFileSync(this.rfRadioPath, JSON.stringify(rfRadio || null, null, 2));
  }

  // pat is ALWAYS pointed at NexPack's own AgwpeBridgeServer, not a real
  // external AGWPE TNC — falls back to the old hardcoded default only if
  // this PatManager somehow wasn't given a bridge port (shouldn't happen
  // outside of a test constructing PatManager on its own).
  _agwpeConfig() {
    if (!this.agwpeBridgePort) return { addr: '127.0.0.1:8000', radio_port: 0 };
    return { addr: `127.0.0.1:${this.agwpeBridgePort}`, radio_port: 0 };
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
      const bin = process.platform === 'win32' ? 'pat.exe' : 'pat';
      // Upstream (la5nta/pat) only publishes windows/i386 and darwin/amd64
      // binaries — no native win/arm64 build needed (32-bit runs fine
      // under WOW64) and no native darwin/arm64 build exists at all (runs
      // under Rosetta 2 instead), so those two are bundled unsplit. Linux
      // does publish real x64 and arm64 builds, and NexPack ships separate
      // packages for each, so that one has to pick the matching arch —
      // bundling the wrong one would just fail to execute outright.
      const bundled = process.platform === 'win32' ? path.join(this.resourcesPath, 'pat', 'win32', bin)
        : process.platform === 'darwin' ? path.join(this.resourcesPath, 'pat', 'darwin', bin)
        : path.join(this.resourcesPath, 'pat', 'linux', process.arch, bin);
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
  //
  // pat reads its config once at startup and never hot-reloads it — a file
  // write alone does nothing to an already-running process. Without the
  // restart below, editing your callsign/password while pat is running
  // (e.g. fixing a typo after a failed login) silently keeps using the OLD
  // in-memory value for every future connect attempt until the whole app
  // is restarted, which is exactly what happened during manual testing: a
  // password change was saved correctly to disk the whole time, but the
  // already-running pat process never picked it up.
  // Deliberately does no async work before this write (and no earlier
  // await in the whole function): callers throughout this codebase call
  // saveSettings() without awaiting it and rely on the file already being
  // correct by the next synchronous line.
  async saveSettings({ callsign, winlinkPassword, connectAliases = {}, rfRadio }) {
    const base = this.getSettings() || {};
    if (rfRadio !== undefined) this._saveRfRadio(rfRadio);
    const merged = {
      ...base,
      mycall: (callsign || '').toUpperCase(),
      secure_login_password: winlinkPassword || '',
      http_addr: base.http_addr || '127.0.0.1:0',
      connect_aliases: { ...(base.connect_aliases || {}), ...connectAliases },
      // engine forced to 'agwpe' unconditionally (not just defaulted when
      // ax25 is entirely absent) — every RF connect now goes through
      // AgwpeBridgeServer, so any OTHER engine value already sitting in an
      // existing config.json (e.g. 'serial-tnc' from before the bridge
      // existed, still pointing at a real COM port) would make pat dial
      // that directly instead of ever reaching the bridge at all: no
      // bridge log lines, no SABM, just a silent hang until pat's own
      // connect timeout — exactly matching a real report where a
      // KISS-TCP-only setup (no serial TNC even in the picture) still
      // produced a full timeout with zero bridge activity.
      ax25: { ...(base.ax25 || { rig: '', beacon: { every: 0, message: '', destination: 'IDENT' } }), engine: 'agwpe' },
      agwpe: this._agwpeConfig()
    };
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
    if (this.proc || this._startPromise) {
      this.emit('log', 'Settings changed — restarting pat so the new values take effect...\n');
      await this.stop();
      await this.start();
    }
    return merged;
  }

  // Re-entrant: a second call while the first is still starting up (e.g.
  // React's dev-mode double-effect invocation) returns the SAME in-flight
  // promise, rather than racing past a `this.proc` truthiness check that
  // gets set before the server is actually confirmed listening.
  start() {
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._doStart().finally(() => { this._startPromise = null; });
    return this._startPromise;
  }

  async _doStart() {
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
    settings.agwpe = this._agwpeConfig();
    // Belt-and-suspenders alongside saveSettings()'s own forced engine:
    // guarantees a config.json saved before this fix existed (with a stale
    // 'serial-tnc' or other non-agwpe engine) gets corrected on every real
    // pat launch too, not only after the user next revisits Winlink
    // settings and hits Save.
    settings.ax25 = { ...(settings.ax25 || {}), engine: 'agwpe' };
    fs.writeFileSync(this.configPath, JSON.stringify(settings, null, 2));

    const bin = this._resolveBinaryPath();
    this.proc = spawn(bin, ['--config', this.configPath, '--mbox', this.mboxDir, '--forms', this.formsDir, 'http'], { stdio: ['ignore', 'pipe', 'pipe'] });
    fs.writeFileSync(this.pidFilePath, String(this.proc.pid));
    this.proc.stdout.on('data', (d) => this.emit('log', d.toString()));
    this.proc.stderr.on('data', (d) => this.emit('log', d.toString()));
    this.proc.on('exit', (code) => { this.emit('exit', code); this.proc = null; this._removePidFile(); this._closeSocket(); });

    // A spawn failure (missing binary, no permission, etc.) fires this
    // 'error' event asynchronously, AFTER spawn() has already returned —
    // it can't be caught with a try/catch around spawn() itself. Node also
    // throws (crashing the whole Electron process) if 'error' is ever
    // emitted with zero listeners. While a start() call is in flight, that
    // failure is already fully surfaced via the rejected promise below —
    // re-emitting it as PatManager's own 'error' too would crash the
    // process independent of whether the promise path works, regardless of
    // whether anything happens to be listening. Only re-emit for a genuine
    // *post-startup* failure (pat crashing unexpectedly once already
    // running), which nothing else surfaces.
    let spawnError = null;
    let starting = true;
    this.proc.on('error', (err) => {
      spawnError = err;
      this.proc = null;
      this._removePidFile();
      if (!starting) this.emit('error', err);
    });

    try {
      await this._waitForHttp();
    } catch (e) {
      if (spawnError) {
        const friendly = spawnError.code === 'ENOENT'
          ? `Can't find the pat program at "${bin}" — it needs to be installed and on your PATH (or bundled with this NexPack build).`
          : `pat failed to start: ${spawnError.message}`;
        throw new Error(friendly);
      }
      throw e;
    } finally {
      starting = false;
    }
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

  // Winlink Standard Forms (ICS-213, radiogram, etc.) — pat already has a
  // complete, real implementation of this (the same one its own bundled
  // web GUI uses), reverse-engineered by running the real bundled binary
  // and reading its actual web GUI's JS, not guessed:
  //   GET  /api/formcatalog            -> {name,path,version,form_count,forms:[],folders:[...]} tree
  //   POST /api/formsUpdate            -> downloads the latest official templates from winlink.org
  //   GET  /api/forms?template=<path>  -> renders the real, official HTML form for that template
  //   (the rendered form's own <form method="post" action="/api/form?template=..."> submits itself —
  //    nothing else needs to drive that part)
  //   GET  /api/form                   -> 404 until that form is submitted, then {msg_to,msg_cc,msg_subject,msg_body}
  // The GET/POST /api/form pair is correlated by a plain browser cookie
  // named "forminstance" — pat's own web GUI sets it with document.cookie
  // before opening the form window (same-origin, so the browser attaches
  // it automatically to the form's own POST); NexPack has to set that same
  // cookie on whatever BrowserWindow opens the form (see index.js) and
  // pass it manually here since this uses a plain HTTP client, not that
  // window's own cookie jar. Confirmed end-to-end against the real binary,
  // including that submitting a form actually returns
  // "<script>window.close()</script>" — the window closes itself, no need
  // to do that from here.
  listFormCatalog() { return this._request('GET', '/api/formcatalog'); }
  updateForms() { return this._request('POST', '/api/formsUpdate'); }
  formUrl(templatePath, inReplyTo) {
    const qs = new URLSearchParams({ template: templatePath });
    if (inReplyTo) qs.set('in-reply-to', inReplyTo);
    return this._url(`/api/forms?${qs.toString()}`);
  }
  async getFormResult(forminstanceId) {
    try {
      return await this._request('GET', '/api/form', { headers: { Cookie: `forminstance=${forminstanceId}` } });
    } catch (e) {
      if (/-> 404:/.test(e.message)) return null; // not submitted yet — not a real error
      throw e;
    }
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

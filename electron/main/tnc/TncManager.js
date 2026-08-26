const EventEmitter = require('events');
const fs = require('fs');
const crypto = require('crypto');
const { parseAx25Frame, buildAx25Frame } = require('../ax25/ax25');
const { escapeFrame, unescapeStream } = require('../ax25/kiss');
const SerialKissAdapter = require('../adapters/SerialKissAdapter');
const KissTcpAdapter = require('../adapters/KissTcpAdapter');
const AgwpeAdapter = require('../adapters/AgwpeAdapter');

const CTL = {
  UI: 0x03,
  SABM: 0x2f, SABM_P: 0x3f,
  UA: 0x63, UA_F: 0x73,
  DISC: 0x43, DISC_P: 0x53,
  DM: 0x0f, DM_F: 0x1f
};

function classifyControl(control) {
  const isSABM = control === CTL.SABM || control === CTL.SABM_P || control === 0x6f;
  const isUA = (control & ~0x10) === CTL.UA;
  const isDISC = (control & ~0x10) === CTL.DISC;
  const isDM = (control & ~0x10) === CTL.DM;
  const isUI = control === CTL.UI;
  const isSupervisory = (control & 0x03) === 0x01;
  const isI = (control & 0x01) === 0x00 && !isSABM;
  if (isSABM) return 'sabm';
  if (isUA) return 'ua';
  if (isDISC) return 'disc';
  if (isDM) return 'dm';
  if (isUI) return 'ui';
  if (isSupervisory) return 'supervisory';
  if (isI) return 'iframe';
  return 'unknown';
}

function id() { return crypto.randomUUID(); }

// Owns every configured TNC + its radios, the live adapter connections, and
// lightweight connected-mode sessions for the terminal. This is the piece
// NexDigi has no equivalent of (its channelManager.js is a flat
// channel->adapter map with no TNC/radio hierarchy) — deliberately new.
class TncManager extends EventEmitter {
  constructor({ configPath } = {}) {
    super();
    this.configPath = configPath;
    this.tncs = new Map(); // id -> { config: {id,name,type,connection,radios:[]}, adapter, status, rxBuffer }
    this.sessions = new Map(); // sessionId -> session state
    this._load();
  }

  // ---- persistence ----
  _load() {
    if (!this.configPath) return;
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const list = JSON.parse(raw);
      for (const config of list) this.tncs.set(config.id, { config, adapter: null, status: 'disconnected', rxBuffer: Buffer.alloc(0) });
    } catch (e) { /* no config yet */ }
  }

  _save() {
    if (!this.configPath) return;
    const list = Array.from(this.tncs.values()).map((t) => t.config);
    try { fs.writeFileSync(this.configPath, JSON.stringify(list, null, 2)); } catch (e) { this.emit('error', e); }
  }

  // ---- TNC / radio CRUD ----
  listTncs() {
    return Array.from(this.tncs.values()).map((t) => ({ ...t.config, status: t.status }));
  }

  createTnc({ name, type, connection }) {
    const config = { id: id(), name, type, connection, radios: [] };
    this.tncs.set(config.id, { config, adapter: null, status: 'disconnected', rxBuffer: Buffer.alloc(0) });
    this._save();
    this.emit('tnc-list-changed');
    return config;
  }

  updateTnc(tncId, patch) {
    const t = this.tncs.get(tncId);
    if (!t) throw new Error('unknown TNC');
    Object.assign(t.config, patch);
    this._save();
    this.emit('tnc-list-changed');
  }

  removeTnc(tncId) {
    this.disconnectTnc(tncId);
    this.tncs.delete(tncId);
    this._save();
    this.emit('tnc-list-changed');
  }

  addRadio(tncId, { callsign, name, portNumber = 0 }) {
    const t = this.tncs.get(tncId);
    if (!t) throw new Error('unknown TNC');
    const radio = { id: id(), callsign, name, portNumber };
    t.config.radios.push(radio);
    this._save();
    this.emit('tnc-list-changed');
    return radio;
  }

  removeRadio(tncId, radioId) {
    const t = this.tncs.get(tncId);
    if (!t) throw new Error('unknown TNC');
    t.config.radios = t.config.radios.filter((r) => r.id !== radioId);
    this._save();
    this.emit('tnc-list-changed');
  }

  // ---- connection lifecycle ----
  connectTnc(tncId) {
    const t = this.tncs.get(tncId);
    if (!t) throw new Error('unknown TNC');
    if (t.adapter) return; // already connecting/connected
    const conn = t.config.connection || {};
    if (t.config.type === 'serial') {
      t.adapter = new SerialKissAdapter({ port: conn.path, baud: conn.baud || 9600 });
    } else if (t.config.type === 'kiss-tcp') {
      t.adapter = new KissTcpAdapter({ host: conn.host, port: conn.port });
    } else if (t.config.type === 'agwpe') {
      t.adapter = new AgwpeAdapter({ host: conn.host, port: conn.port, callsign: (t.config.radios[0] && t.config.radios[0].callsign) || 'N0CALL' });
    } else {
      throw new Error(`unknown TNC type: ${t.config.type}`);
    }
    this._wireAdapter(t);
    this._setStatus(t, 'connecting');
  }

  disconnectTnc(tncId) {
    const t = this.tncs.get(tncId);
    if (!t || !t.adapter) return;
    try { t.adapter.close(); } catch (e) { /* ignore */ }
    t.adapter = null;
    this._setStatus(t, 'disconnected');
  }

  _setStatus(t, status, error) {
    t.status = status;
    this.emit('tnc-status', { tncId: t.config.id, status, error: error ? String(error.message || error) : null });
  }

  _wireAdapter(t) {
    const { adapter, config } = t;
    adapter.on('open', () => this._setStatus(t, 'connected'));
    adapter.on('close', () => this._setStatus(t, 'disconnected'));
    adapter.on('error', (e) => this._setStatus(t, 'error', e));
    if (config.type === 'agwpe') {
      adapter.on('frame', ({ port, ax25Frame }) => this._handleIncomingAx25(t, this._radioForPort(t, port), ax25Frame));
      adapter.on('portInfo', (ports) => this.emit('port-info', { tncId: config.id, ports }));
    } else {
      adapter.on('data', (chunk) => this._onRawKissData(t, chunk));
    }
  }

  _radioForPort(t, portNumber) {
    return t.config.radios.find((r) => (r.portNumber || 0) === portNumber) || t.config.radios[0] || null;
  }

  // Same fixed-boundary KISS de-escaping approach NexDigi's channelManager.js
  // now uses (it originally had a byte-corruption bug from a hand-rolled
  // re-implementation that never de-escaped — built correctly here from the
  // start using the shared unescapeStream()).
  _onRawKissData(t, chunk) {
    t.rxBuffer = Buffer.concat([t.rxBuffer, chunk]);
    let processed = 0;
    for (;;) {
      const startFend = t.rxBuffer.indexOf(0xc0, processed);
      if (startFend === -1) break;
      const endFend = t.rxBuffer.indexOf(0xc0, startFend + 1);
      if (endFend === -1) break;
      const rawFrame = t.rxBuffer.slice(startFend, endFend + 1);
      try {
        for (const { port, frame } of unescapeStream(rawFrame)) {
          if (frame.length > 0) this._handleIncomingAx25(t, this._radioForPort(t, port), frame);
        }
      } catch (e) { /* skip invalid frame */ }
      processed = endFend + 1;
    }
    t.rxBuffer = t.rxBuffer.slice(processed);
    if (t.rxBuffer.length > 8192) t.rxBuffer = Buffer.alloc(0); // safety valve against garbage streams
  }

  _txAx25Frame(t, radio, ax25Frame) {
    if (t.config.type === 'agwpe') {
      t.adapter.sendFrame(radio ? radio.portNumber || 0 : 0, ax25Frame, { callFrom: radio && radio.callsign });
    } else {
      t.adapter.send(escapeFrame(ax25Frame, radio ? radio.portNumber || 0 : 0));
    }
  }

  _emitMonitor(t, radio, direction, frameType, parsed, raw) {
    let text;
    try { text = parsed.payload && parsed.payload.length ? parsed.payload.toString('utf8') : ''; } catch (e) { text = ''; }
    this.emit('monitor', {
      tncId: t.config.id,
      radioId: radio ? radio.id : null,
      direction,
      frameType,
      timestamp: Date.now(),
      addresses: (parsed.addresses || []).map((a) => `${a.callsign}${a.ssid ? '-' + a.ssid : ''}`),
      control: parsed.control,
      text,
      raw: raw.toString('hex')
    });
  }

  // ---- inbound frame handling ----
  _handleIncomingAx25(t, radio, ax25Frame) {
    let parsed;
    try { parsed = parseAx25Frame(ax25Frame); } catch (e) {
      this.emit('monitor', { tncId: t.config.id, radioId: radio ? radio.id : null, direction: 'rx', frameType: 'error', timestamp: Date.now(), text: `malformed frame: ${e.message}`, raw: ax25Frame.toString('hex') });
      return;
    }
    const frameType = classifyControl(parsed.control);
    this._emitMonitor(t, radio, 'rx', frameType, parsed, ax25Frame);

    if (!radio || parsed.addresses.length < 2) return;
    const destCall = parsed.addresses[0].callsign;
    const srcAddr = parsed.addresses[1];
    const srcCall = srcAddr.ssid ? `${srcAddr.callsign}-${srcAddr.ssid}` : srcAddr.callsign;
    const addressedToUs = destCall.toUpperCase() === String(radio.callsign || '').split('-')[0].toUpperCase();
    if (!addressedToUs) return;

    const sessionKey = `${t.config.id}:${radio.id}:${srcCall}`;
    let session = this.sessions.get(sessionKey);

    if (frameType === 'sabm') {
      session = session || this._newSession(t, radio, srcCall, sessionKey);
      session.state = 'connected';
      session.vr = 0; session.vs = 0;
      this._txAx25Frame(t, radio, buildAx25Frame({ dest: srcCall, src: radio.callsign, control: CTL.UA_F, pid: null, payload: Buffer.alloc(0) }));
      this.emit('session-state', this._sessionSnapshot(session));
    } else if (frameType === 'ua' && session && session.state === 'connecting') {
      session.state = 'connected';
      this.emit('session-state', this._sessionSnapshot(session));
    } else if (frameType === 'disc' && session) {
      this._txAx25Frame(t, radio, buildAx25Frame({ dest: srcCall, src: radio.callsign, control: CTL.UA_F, pid: null, payload: Buffer.alloc(0) }));
      session.state = 'disconnected';
      this.emit('session-state', this._sessionSnapshot(session));
      this.sessions.delete(sessionKey);
    } else if (frameType === 'iframe' && session && session.state === 'connected') {
      const ns = (parsed.control >> 1) & 0x07;
      session.vr = (ns + 1) % 8;
      let text = '';
      try { text = parsed.payload.toString('utf8'); } catch (e) { /* ignore */ }
      session.buffer.push(text);
      this.emit('session-data', { sessionId: session.id, text });
      const rrControl = ((session.vr & 0x07) << 5) | 0x01;
      this._txAx25Frame(t, radio, buildAx25Frame({ dest: srcCall, src: radio.callsign, control: rrControl, pid: null, payload: Buffer.alloc(0) }));
    }
  }

  // ---- outbound: unconnected (UI) ----
  sendUnproto(tncId, radioId, destCallsign, text) {
    const t = this.tncs.get(tncId);
    const radio = t.config.radios.find((r) => r.id === radioId);
    if (!t || !radio) throw new Error('unknown TNC/radio');
    const payload = Buffer.from(text, 'utf8');
    const frame = buildAx25Frame({ dest: destCallsign, src: radio.callsign, control: CTL.UI, pid: 0xf0, payload });
    this._txAx25Frame(t, radio, frame);
    this._emitMonitor(t, radio, 'tx', 'ui', { addresses: [{ callsign: destCallsign, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control: CTL.UI, payload }, frame);
  }

  // ---- outbound: connected-mode sessions ----
  _newSession(t, radio, remoteCall, sessionKey) {
    const session = { id: id(), key: sessionKey, tncId: t.config.id, radioId: radio.id, remoteCall, state: 'connecting', vs: 0, vr: 0, buffer: [] };
    this.sessions.set(sessionKey, session);
    return session;
  }

  _sessionSnapshot(s) {
    return { id: s.id, tncId: s.tncId, radioId: s.radioId, remoteCall: s.remoteCall, state: s.state };
  }

  startSession(tncId, radioId, remoteCall) {
    const t = this.tncs.get(tncId);
    const radio = t && t.config.radios.find((r) => r.id === radioId);
    if (!t || !radio) throw new Error('unknown TNC/radio');
    const sessionKey = `${tncId}:${radioId}:${remoteCall}`;
    const session = this._newSession(t, radio, remoteCall, sessionKey);
    const frame = buildAx25Frame({ dest: remoteCall, src: radio.callsign, control: CTL.SABM_P, pid: null, payload: Buffer.alloc(0) });
    this._txAx25Frame(t, radio, frame);
    this._emitMonitor(t, radio, 'tx', 'sabm', { addresses: [{ callsign: remoteCall, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control: CTL.SABM_P, payload: Buffer.alloc(0) }, frame);
    return this._sessionSnapshot(session);
  }

  sendSessionText(sessionId, text) {
    const session = Array.from(this.sessions.values()).find((s) => s.id === sessionId);
    if (!session || session.state !== 'connected') throw new Error('session not connected');
    const t = this.tncs.get(session.tncId);
    const radio = t.config.radios.find((r) => r.id === session.radioId);
    const control = ((session.vr & 0x07) << 5) | ((session.vs & 0x07) << 1);
    session.vs = (session.vs + 1) % 8;
    const payload = Buffer.from(text, 'utf8');
    const frame = buildAx25Frame({ dest: session.remoteCall, src: radio.callsign, control, pid: 0xf0, payload });
    this._txAx25Frame(t, radio, frame);
    this._emitMonitor(t, radio, 'tx', 'iframe', { addresses: [{ callsign: session.remoteCall, ssid: 0 }, { callsign: radio.callsign, ssid: 0 }], control, payload }, frame);
  }

  endSession(sessionId) {
    const session = Array.from(this.sessions.values()).find((s) => s.id === sessionId);
    if (!session) return;
    const t = this.tncs.get(session.tncId);
    const radio = t.config.radios.find((r) => r.id === session.radioId);
    const frame = buildAx25Frame({ dest: session.remoteCall, src: radio.callsign, control: CTL.DISC_P, pid: null, payload: Buffer.alloc(0) });
    this._txAx25Frame(t, radio, frame);
    session.state = 'disconnected';
    this.emit('session-state', this._sessionSnapshot(session));
    this.sessions.delete(session.key);
  }

  shutdown() {
    for (const tncId of this.tncs.keys()) this.disconnectTnc(tncId);
  }
}

module.exports = TncManager;
module.exports.classifyControl = classifyControl;

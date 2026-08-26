const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { parsePosition, parseWeather, decodeMicE, parseTnc2Line } = require('./aprsParser');

const MAX_TRACK_POINTS = 100;

// Two independent, separately-toggleable APRS data sources:
//  - RF: passive monitoring of NexPack's own already-running TncManager.
//    Always on if any TNC/radio is configured — no settings, no internet.
//  - APRS-IS: optional, off by default, a real connection to the real
//    APRS-IS network. Mic-E decoding is RF-only for this milestone (it
//    needs the raw AX.25 destination-address bytes, which we have on the
//    RF path but would need extra work to recover reliably from APRS-IS's
//    already-reformatted TNC2 text) — uncompressed/compressed/weather
//    formats are covered on both paths, which is the large majority of
//    real APRS-IS traffic regardless.
class AprsManager extends EventEmitter {
  constructor({ userDataDir, tncManager }) {
    super();
    this.configPath = path.join(userDataDir, 'aprs.json');
    this.tncManager = tncManager;
    this.stations = new Map();
    this.aprsIsSocket = null;
    this.aprsIsClosed = true;
    this._aprsIsBuffer = '';
    this._reconnectTimer = null;

    this.tncManager.on('monitor', (evt) => this._handleRfFrame(evt));
  }

  getSettings() {
    if (!fs.existsSync(this.configPath)) return { aprsIs: { enabled: false, host: 'noam.aprs2.net', port: 14580, passcode: '-1', filter: '', callsign: '' } };
    try { return JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch (e) { return { aprsIs: { enabled: false } }; }
  }

  saveSettings(settings) {
    fs.writeFileSync(this.configPath, JSON.stringify(settings, null, 2));
    const wasConnected = !this.aprsIsClosed;
    this.disconnectAprsIs();
    if (settings.aprsIs && settings.aprsIs.enabled) this.connectAprsIs();
    return settings;
  }

  getStations() { return Array.from(this.stations.values()); }

  // ---- shared station update path ----
  _updateStation(callsign, decoded, source) {
    if (!decoded) return;
    const existing = this.stations.get(callsign);
    const position = decoded.latitude !== undefined ? { lat: decoded.latitude, lon: decoded.longitude, course: decoded.course, speed: decoded.speed } : (existing && existing.lastPosition);
    const record = {
      callsign,
      symbol: decoded.symbol || (existing && existing.symbol),
      lastPosition: position,
      positionHistory: existing ? existing.positionHistory.slice() : [],
      lastSeen: Date.now(),
      source,
      comment: decoded.status || (existing && existing.comment) || '',
      weather: decoded.type === 'aprs_weather' ? decoded : (existing && existing.weather)
    };
    if (decoded.latitude !== undefined) {
      record.positionHistory.push({ lat: decoded.latitude, lon: decoded.longitude, timestamp: record.lastSeen });
      if (record.positionHistory.length > MAX_TRACK_POINTS) record.positionHistory.shift();
    }
    this.stations.set(callsign, record);
    this.emit('aprs-station', record);
  }

  // ---- RF ingestion ----
  _handleRfFrame(evt) {
    if (evt.frameType !== 'ui' || !evt.text) return;
    const srcAddr = (evt.addresses && evt.addresses[1]) || null;
    if (!srcAddr) return;
    const callsign = srcAddr;

    let decoded = parsePosition(evt.text);
    if (!decoded) decoded = parseWeather(evt.text);
    if (!decoded && evt.raw) {
      try {
        const rawBuf = Buffer.from(evt.raw, 'hex');
        const destBytes = Buffer.from(rawBuf.slice(0, 6)).map((b) => b >> 1);
        decoded = decodeMicE(destBytes, evt.text);
      } catch (e) { /* not Mic-E */ }
    }
    if (decoded) this._updateStation(callsign, decoded, 'rf');
  }

  // ---- APRS-IS ----
  connectAprsIs() {
    if (this.aprsIsSocket) return;
    const settings = this.getSettings();
    const cfg = settings.aprsIs || {};
    if (!cfg.host || !cfg.port) throw new Error('APRS-IS host/port not configured');
    this.aprsIsClosed = false;
    this._aprsIsBuffer = '';
    this.aprsIsSocket = net.createConnection({ host: cfg.host, port: cfg.port });
    this.aprsIsSocket.on('connect', () => {
      const login = `user ${(cfg.callsign || 'N0CALL').toUpperCase()} pass ${cfg.passcode || '-1'} vers NexPack 0.1${cfg.filter ? ` filter ${cfg.filter}` : ''}\r\n`;
      this.aprsIsSocket.write(login);
      this.emit('aprs-is-status', { connected: true });
    });
    this.aprsIsSocket.on('data', (chunk) => this._onAprsIsData(chunk));
    this.aprsIsSocket.on('error', (err) => this.emit('aprs-is-status', { connected: false, error: err.message }));
    this.aprsIsSocket.on('close', () => {
      this.aprsIsSocket = null;
      this.emit('aprs-is-status', { connected: false });
      if (!this.aprsIsClosed) this._reconnectTimer = setTimeout(() => this.connectAprsIs(), 10000);
    });
  }

  disconnectAprsIs() {
    this.aprsIsClosed = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.aprsIsSocket) { try { this.aprsIsSocket.destroy(); } catch (e) { /* ignore */ } this.aprsIsSocket = null; }
    this.emit('aprs-is-status', { connected: false });
  }

  _onAprsIsData(chunk) {
    this._aprsIsBuffer += chunk.toString('utf8');
    const lines = this._aprsIsBuffer.split(/\r?\n/);
    this._aprsIsBuffer = lines.pop(); // last element may be a partial line
    for (const line of lines) this._handleAprsIsLine(line);
  }

  _handleAprsIsLine(line) {
    const parsed = parseTnc2Line(line);
    if (!parsed) return;
    let decoded = parsePosition(parsed.payload);
    if (!decoded) decoded = parseWeather(parsed.payload);
    if (decoded) this._updateStation(parsed.from, decoded, 'aprs-is');
  }

  shutdown() {
    this.disconnectAprsIs();
  }
}

module.exports = AprsManager;

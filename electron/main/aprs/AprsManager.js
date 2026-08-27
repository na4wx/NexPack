const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const {
  parsePosition, parseWeather, decodeMicE, parseTnc2Line,
  parseMessage, buildMessagePacket, buildAckPacket, buildPositionPacket,
  parseObject, buildObjectPacket, parseTelemetry, parseTelemetryMetadata
} = require('./aprsParser');

const MAX_TRACK_POINTS = 100;
const MAX_PACKET_LOG = 50;
const MESSAGE_RETRY_MS = 45000;
const MESSAGE_MAX_RETRIES = 4;

function distanceBearing(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceMiles = R * c;
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return { distanceMiles, bearing };
}

// Two independent, separately-toggleable receive sources (RF always-on,
// APRS-IS optional — see Milestone 4), extended here with real transmit
// capability (beaconing, messaging with ack/retry, objects/items,
// telemetry) so this behaves like an actual APRS client (UI-View/
// APRSIS32/YAAC) rather than a passive position viewer.
class AprsManager extends EventEmitter {
  constructor({ userDataDir, tncManager }) {
    super();
    this.configPath = path.join(userDataDir, 'aprs.json');
    this.tncManager = tncManager;
    this.stations = new Map();
    this.objects = new Map();
    this.messages = []; // {id, direction, callsign, text, msgId, status, timestamp}
    this.pendingAcks = new Map(); // msgId -> {addressee, text, retries, timer}
    this.aprsIsSocket = null;
    this.aprsIsClosed = true;
    this._aprsIsBuffer = '';
    this._reconnectTimer = null;
    this._beaconTimer = null;

    this.tncManager.on('monitor', (evt) => this._handleRfFrame(evt));
    this._applyBeaconSchedule();
  }

  // ---- settings (APRS-IS + My Station, same config file) ----
  getSettings() {
    const defaults = {
      aprsIs: { enabled: false, host: 'noam.aprs2.net', port: 14580, passcode: '-1', filter: '', callsign: '', txPasscode: '' },
      myStation: { mycall: '', symbol: '/>', comment: '', homePosition: null, beacon: { enabled: false, intervalMinutes: 30, path: 'WIDE1-1,WIDE2-1', tncId: null, radioId: null } }
    };
    if (!fs.existsSync(this.configPath)) return defaults;
    try {
      const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return { ...defaults, ...saved, aprsIs: { ...defaults.aprsIs, ...(saved.aprsIs || {}) }, myStation: { ...defaults.myStation, ...(saved.myStation || {}), beacon: { ...defaults.myStation.beacon, ...((saved.myStation || {}).beacon || {}) } } };
    } catch (e) { return defaults; }
  }

  saveSettings(settings) {
    const merged = { ...this.getSettings(), ...settings };
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
    this.disconnectAprsIs();
    if (merged.aprsIs && merged.aprsIs.enabled) this.connectAprsIs();
    this._applyBeaconSchedule();
    return merged;
  }

  saveMyStation(myStation) { return this.saveSettings({ myStation }); }
  getMyStation() { return this.getSettings().myStation; }

  getStations() { return Array.from(this.stations.values()); }
  getObjects() { return Array.from(this.objects.values()); }
  getMessages() { return this.messages.slice(); }

  markMessageRead(id) {
    const entry = this.messages.find((m) => m.id === id);
    if (entry) { entry.read = true; this.emit('aprs-message', entry); }
    return entry;
  }

  // ---- distance/bearing (attached whenever a home position is set) ----
  _withDistanceBearing(record) {
    const home = this.getMyStation().homePosition;
    if (!home || !record.lastPosition) return record;
    const { distanceMiles, bearing } = distanceBearing(home.lat, home.lon, record.lastPosition.lat, record.lastPosition.lon);
    return { ...record, distanceMiles, bearing };
  }

  // ---- shared station update path ----
  _updateStation(callsign, updates, source, rawPacket) {
    const existing = this.stations.get(callsign);
    const hasPosition = updates.latitude !== undefined;
    const position = hasPosition ? { lat: updates.latitude, lon: updates.longitude, course: updates.course, speed: updates.speed } : (existing && existing.lastPosition);
    const record = {
      callsign,
      symbol: updates.symbol || (existing && existing.symbol),
      lastPosition: position,
      positionHistory: existing ? existing.positionHistory.slice() : [],
      packetLog: existing ? existing.packetLog.slice() : [],
      lastSeen: Date.now(),
      source,
      comment: updates.status || (existing && existing.comment) || '',
      weather: updates.weather || (existing && existing.weather),
      telemetry: existing && existing.telemetry
    };
    if (hasPosition) {
      record.positionHistory.push({ lat: updates.latitude, lon: updates.longitude, timestamp: record.lastSeen });
      if (record.positionHistory.length > MAX_TRACK_POINTS) record.positionHistory.shift();
    }
    if (rawPacket) {
      record.packetLog.push({ raw: rawPacket, timestamp: record.lastSeen, source });
      if (record.packetLog.length > MAX_PACKET_LOG) record.packetLog.shift();
    }
    const withDistance = this._withDistanceBearing(record);
    this.stations.set(callsign, withDistance);
    this.emit('aprs-station', withDistance);
    return withDistance;
  }

  // ---- unified packet classification, shared by RF and APRS-IS ----
  // destBytes is only available on the RF path (needed for Mic-E).
  // Dispatch by the real APRS Data Type Identifier (the payload's leading
  // byte) rather than trying every parser in sequence — parsePosition's
  // regexes are intentionally unanchored (compressed/uncompressed reports
  // can appear mid-payload, e.g. inside a weather packet's comment), so
  // trying it against a ';' object or ':' message payload can spuriously
  // match garbage buried in the name/timestamp/addressee fields.
  _ingestPacket({ callsign, text, source, destBytes }) {
    if (!callsign || !text) return;
    const dti = text[0];

    if (dti === ';') {
      const objectDecoded = parseObject(text);
      if (objectDecoded) { this._handleObject(callsign, objectDecoded, source, text); return; }
    }

    if (dti === ':') {
      const messageDecoded = parseMessage(text);
      if (messageDecoded) { this._handleMessage(callsign, messageDecoded, source, text); return; }
    }

    if (dti === 'T' && text[1] === '#') {
      const telemetryDecoded = parseTelemetry(text);
      if (telemetryDecoded) { this._handleTelemetry(callsign, telemetryDecoded, source, text); return; }
    }

    if (dti === '!' || dti === '=' || dti === '@' || dti === '/' || dti === '_') {
      const posDecoded = parsePosition(text);
      const weatherDecoded = parseWeather(text);
      if (posDecoded || weatherDecoded) {
        const merged = { ...(posDecoded || {}) };
        if (weatherDecoded) merged.weather = weatherDecoded;
        this._updateStation(callsign, merged, source, text);
        return;
      }
    }

    if (destBytes) {
      try {
        const micEDecoded = decodeMicE(destBytes, text);
        if (micEDecoded) { this._updateStation(callsign, micEDecoded, source, text); return; }
      } catch (e) { /* not Mic-E */ }
    }
  }

  // ---- RF ingestion ----
  _handleRfFrame(evt) {
    // TncManager's 'monitor' event fires for both rx AND our own tx frames —
    // without this check, sending anything (a beacon, a message) makes us
    // "hear" our own transmission as if it were real incoming RF traffic
    // from ourselves (e.g. a phantom "received" copy of a message we just sent).
    if (evt.direction !== 'rx') return;
    if (evt.frameType !== 'ui' || !evt.text) return;
    const srcAddr = (evt.addresses && evt.addresses[1]) || null;
    if (!srcAddr) return;
    let destBytes = null;
    if (evt.raw) {
      try { destBytes = Buffer.from(Buffer.from(evt.raw, 'hex').slice(0, 6)).map((b) => b >> 1); } catch (e) { /* ignore */ }
    }
    this._ingestPacket({ callsign: srcAddr, text: evt.text, source: 'rf', destBytes });
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
    this._ingestPacket({ callsign: parsed.from, text: parsed.payload, source: 'aprs-is' });
  }

  // ---- outgoing transmission (RF always; APRS-IS only if a real tx passcode is set) ----
  _transmit(packet) {
    const settings = this.getSettings();
    const beacon = settings.myStation.beacon || {};
    if (beacon.tncId && beacon.radioId) {
      try { this.tncManager.sendUnproto(beacon.tncId, beacon.radioId, 'APRS', packet); } catch (e) { this.emit('aprs-error', { message: `RF transmit failed: ${e.message}` }); }
    }
    if (settings.aprsIs.txPasscode && this.aprsIsSocket && !this.aprsIsSocket.destroyed) {
      const mycall = (settings.myStation.mycall || settings.aprsIs.callsign || 'N0CALL').toUpperCase();
      this.aprsIsSocket.write(`${mycall}>APRS,TCPIP*:${packet}\r\n`);
    }
  }

  // ---- beaconing ----
  _applyBeaconSchedule() {
    if (this._beaconTimer) { clearInterval(this._beaconTimer); this._beaconTimer = null; }
    const beacon = this.getMyStation().beacon || {};
    if (beacon.enabled && beacon.intervalMinutes > 0) {
      this._beaconTimer = setInterval(() => this.beaconNow(), beacon.intervalMinutes * 60000);
    }
  }

  beaconNow() {
    const my = this.getMyStation();
    if (!my.mycall) throw new Error('My Station callsign is not set');
    if (!my.homePosition) throw new Error('My Station position is not set');
    const packet = buildPositionPacket({ lat: my.homePosition.lat, lon: my.homePosition.lon, symbol: my.symbol, comment: my.comment });
    this._transmit(packet);
    this._updateStation(my.mycall.toUpperCase(), parsePosition(packet), 'self', packet);
    this.emit('aprs-beacon-sent', { packet, timestamp: Date.now() });
  }

  // ---- messaging (APRS101.PDF Chapter 14) ----
  sendMessage(toCallsign, text) {
    const my = this.getMyStation();
    if (!my.mycall) throw new Error('My Station callsign is not set');
    const msgId = crypto.randomBytes(2).toString('hex').slice(0, 4);
    const packet = buildMessagePacket({ addressee: toCallsign, text, msgId });
    this._transmit(packet);
    const entry = { id: msgId, direction: 'out', callsign: toCallsign.toUpperCase(), text, msgId, status: 'sent', timestamp: Date.now() };
    this.messages.push(entry);
    this.emit('aprs-message', entry);
    this._scheduleRetry(msgId, toCallsign, text);
    return entry;
  }

  _scheduleRetry(msgId, addressee, text, retries = 0) {
    if (retries >= MESSAGE_MAX_RETRIES) {
      this._updateMessageStatus(msgId, 'failed');
      return;
    }
    const timer = setTimeout(() => {
      if (!this.pendingAcks.has(msgId)) return; // already acked
      const packet = buildMessagePacket({ addressee, text, msgId });
      this._transmit(packet);
      this._scheduleRetry(msgId, addressee, text, retries + 1);
    }, MESSAGE_RETRY_MS);
    this.pendingAcks.set(msgId, { addressee, text, retries, timer });
  }

  // User-initiated abort of a still-retrying outgoing message — stops the
  // retry timer immediately rather than waiting out the remaining attempts.
  cancelMessage(msgId) {
    if (!this.pendingAcks.has(msgId)) return; // already resolved (acked/failed/rejected) or unknown
    this._updateMessageStatus(msgId, 'cancelled');
  }

  _updateMessageStatus(msgId, status) {
    const entry = this.messages.find((m) => m.msgId === msgId && m.direction === 'out');
    if (entry) { entry.status = status; this.emit('aprs-message', entry); }
    const pending = this.pendingAcks.get(msgId);
    if (pending) { clearTimeout(pending.timer); this.pendingAcks.delete(msgId); }
  }

  _handleMessage(fromCallsign, decoded, source, rawText) {
    const my = this.getMyStation();
    const myBase = (my.mycall || '').toUpperCase();
    if (decoded.isAck || decoded.isRej) {
      // This ack/rej is addressed to whoever WE sent the original message
      // to — the addressee field here is the ORIGINAL RECIPIENT (i.e. us),
      // and fromCallsign is who sent the ack.
      if (myBase && decoded.addressee.toUpperCase() === myBase) {
        this._updateMessageStatus(decoded.msgId, decoded.isAck ? 'acked' : 'rejected');
      }
      return;
    }
    const entry = { id: `${fromCallsign}-${decoded.msgId || Date.now()}`, direction: 'in', callsign: fromCallsign, text: decoded.text, msgId: decoded.msgId, status: 'received', read: false, timestamp: Date.now() };
    this.messages.push(entry);
    this.emit('aprs-message', entry);

    // Telemetry metadata (PARM/UNIT/EQNS) rides on regular messages, not a
    // distinct wire format — check before treating this as a plain message.
    const meta = parseTelemetryMetadata(decoded.text);
    if (meta) this._applyTelemetryMetadata(fromCallsign, meta);

    if (myBase && decoded.addressee.toUpperCase() === myBase && decoded.msgId) {
      const ack = buildAckPacket({ addressee: fromCallsign, msgId: decoded.msgId });
      this._transmit(ack);
    }
  }

  // ---- objects/items ----
  createObject(name, { lat, lon, symbol, comment }) {
    const packet = buildObjectPacket({ name, lat, lon, symbol, comment, killed: false });
    this._transmit(packet);
    const record = { name, killed: false, lat, lon, symbol, comment, ownedByMe: true, lastUpdate: Date.now() };
    this.objects.set(name, record);
    this.emit('aprs-object', record);
    return record;
  }

  killObject(name) {
    const existing = this.objects.get(name);
    const packet = buildObjectPacket({ name, lat: existing ? existing.lat : 0, lon: existing ? existing.lon : 0, symbol: existing ? existing.symbol : '/>', comment: '', killed: true });
    this._transmit(packet);
    const record = { ...(existing || { name }), killed: true, lastUpdate: Date.now() };
    this.objects.set(name, record);
    this.emit('aprs-object', record);
  }

  _handleObject(fromCallsign, decoded, source, rawText) {
    // Any station may take over reporting for an object by re-transmitting
    // the same name — last report wins regardless of sender.
    const record = { name: decoded.name, killed: decoded.killed, lat: decoded.latitude, lon: decoded.longitude, symbol: decoded.symbol, ownerCallsign: fromCallsign, ownedByMe: false, lastUpdate: Date.now() };
    this.objects.set(decoded.name, record);
    this.emit('aprs-object', record);
  }

  // ---- telemetry ----
  _handleTelemetry(fromCallsign, decoded, source, rawText) {
    const existing = this.stations.get(fromCallsign);
    const metadata = (existing && existing.telemetry && existing.telemetry.metadata) || {};
    const scaled = this._scaleTelemetry(decoded.analog, metadata.eqns);
    const record = existing ? { ...existing } : { callsign: fromCallsign, lastSeen: Date.now(), source, packetLog: [], positionHistory: [] };
    record.telemetry = { last: { analog: decoded.analog, scaled, digital: decoded.digital, seq: decoded.seq }, metadata };
    record.lastSeen = Date.now();
    record.packetLog = (record.packetLog || []).concat([{ raw: rawText, timestamp: Date.now(), source }]).slice(-MAX_PACKET_LOG);
    this.stations.set(fromCallsign, record);
    this.emit('aprs-station', record);
  }

  _applyTelemetryMetadata(fromCallsign, meta) {
    const existing = this.stations.get(fromCallsign) || { callsign: fromCallsign, lastSeen: Date.now(), source: 'rf', packetLog: [], positionHistory: [] };
    const telemetry = existing.telemetry || { last: null, metadata: {} };
    if (meta.kind === 'PARM') telemetry.metadata.names = meta.values;
    else if (meta.kind === 'UNIT') telemetry.metadata.units = meta.values;
    else if (meta.kind === 'EQNS') telemetry.metadata.eqns = meta.values;
    if (telemetry.last) telemetry.last.scaled = this._scaleTelemetry(telemetry.last.analog, telemetry.metadata.eqns);
    existing.telemetry = telemetry;
    this.stations.set(fromCallsign, existing);
    this.emit('aprs-station', existing);
  }

  _scaleTelemetry(analog, eqns) {
    if (!eqns) return null;
    return analog.map((v, i) => {
      const eq = eqns[i];
      if (!eq) return v;
      const [a, b, c] = eq;
      return a * v * v + b * v + c;
    });
  }

  shutdown() {
    this.disconnectAprsIs();
    if (this._beaconTimer) clearInterval(this._beaconTimer);
    for (const pending of this.pendingAcks.values()) clearTimeout(pending.timer);
  }
}

module.exports = AprsManager;
